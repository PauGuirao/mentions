/**
 * Billing operations. Pricing model (see CLAUDE.md "Billing"):
 *   - Keywords are PRORATED PER DAY: one event per org per UTC day carrying
 *     that day's active keyword count (Polar Sum meter at EUR 5/30 per
 *     keyword-day). A missed day is an unbilled day.
 *   - EUR 5 per whole 1,000 relevant mentions past the pooled allowance of
 *     POOL_PER_KEYWORD x keyword_max (the cycle's high-water, kept for the
 *     pool only). Units are emitted daily as they accrue; pool growth
 *     applies PROSPECTIVELY — an already-billed unit stays billed, which is
 *     how every quota product behaves. Partial units are forgiven.
 *
 * D1 (usage_cycles + billable_mentions) is the source of truth; the daily
 * billing tick projects usage to Polar as append-only facts (a day's
 * keyword count, a crossed mention unit) that can never become wrong later
 * — Polar meters cannot retract events, so nothing retractable may ever be
 * emitted. Deterministic external_ids make every re-run free.
 * Failure bias everywhere: under-bill, never over-bill.
 */
import type { BillingStatus, UsageSummary } from '../schemas';
import type { PolarClient, PolarEvent } from '../polar';

export const POOL_PER_KEYWORD = 500;
export const MENTION_UNIT_SIZE = 1000;
export const FREE_KEYWORD_LIMIT = 2;
export const PAID_KEYWORD_LIMIT = 100;

/** Polar event names; the dashboard meters filter on these exact strings. */
export const EVENT_KEYWORD_DAYS = 'keyword_days';
export const EVENT_MENTION_UNITS = 'mention_units';

/** Calendar-month UTC cycle key ('2026-08'). Lexicographic order == time
 *  order, which the closeout query relies on (cycle < current). */
export function cycleKey(nowMs: number): string {
  const date = new Date(nowMs);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}`;
}

/** UTC day key ('2026-08-03'); the keyword-day event identity. */
export function dayKey(nowMs: number): string {
  const date = new Date(nowMs);
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${cycleKey(nowMs)}-${day}`;
}

export class KeywordLimitError extends Error {
  constructor(limit: number) {
    super(`Keyword limit reached (${limit}). Upgrade to add more keywords.`);
    this.name = 'KeywordLimitError';
  }
}

interface OrgBillingRow {
  status: BillingStatus;
  polar_subscription_id: string | null;
}

async function getOrgBilling(db: D1Database, orgId: string): Promise<OrgBillingRow | null> {
  return db
    .prepare('SELECT status, polar_subscription_id FROM org_billing WHERE org_id = ?')
    .bind(orgId)
    .first<OrgBillingRow>();
}

export function keywordLimitFor(status: BillingStatus): number {
  return status === 'active' ? PAID_KEYWORD_LIMIT : FREE_KEYWORD_LIMIT;
}

/** The org's current keyword capacity. The CHECK against it must live in the
 *  same SQL statement as the write (see createKeyword) — a separate
 *  read-then-write races concurrent requests past the limit. */
export async function getKeywordLimit(args: { db: D1Database; orgId: string }): Promise<number> {
  const row = await getOrgBilling(args.db, args.orgId);
  return keywordLimitFor(row?.status ?? 'none');
}

/** Raise this cycle's keyword high-water mark to the current active count.
 *  Called after keyword create/unmute; the scheduler heartbeat covers every
 *  other path. Deletes never lower it (you pay for the max you ran, and the
 *  mention pool stays consistent with it). */
export async function syncKeywordUsage(args: {
  db: D1Database;
  orgId: string;
  nowMs?: number;
}): Promise<void> {
  const { db, orgId } = args;
  const nowMs = args.nowMs ?? Date.now();
  const cycle = cycleKey(nowMs);
  await db
    .prepare(
      `INSERT INTO usage_cycles (org_id, cycle, keyword_max, updated_at)
       VALUES (?1, ?2, (SELECT COUNT(*) FROM keywords WHERE org_id = ?1 AND muted = 0), ?3)
       ON CONFLICT(org_id, cycle) DO UPDATE SET
         keyword_max = MAX(keyword_max, (SELECT COUNT(*) FROM keywords WHERE org_id = ?1 AND muted = 0)),
         updated_at = ?3`,
    )
    .bind(orgId, cycle, nowMs)
    .run();
}

/**
 * Count one relevant mention, exactly once per match. The billable_mentions
 * PK is the idempotency; queue redeliveries and the classifier's repair path
 * both funnel here safely. A crash between the two statements loses one
 * count: deliberate (under-bill, never over-bill).
 */
export async function recordBillableMention(args: {
  db: D1Database;
  orgId: string;
  mentionMatchId: string;
  nowMs?: number;
}): Promise<void> {
  const { db, orgId, mentionMatchId } = args;
  const nowMs = args.nowMs ?? Date.now();
  const cycle = cycleKey(nowMs);

  const inserted = await db
    .prepare(
      'INSERT OR IGNORE INTO billable_mentions (mention_match_id, org_id, cycle, created_at) VALUES (?, ?, ?, ?)',
    )
    .bind(mentionMatchId, orgId, cycle, nowMs)
    .run();
  if ((inserted.meta.changes ?? 0) === 0) return;

  // The upsert maintains keyword_max too: in a fresh cycle no keyword
  // mutation may ever run, and a zero high-water mark would make the pool
  // zero and every mention billable overage.
  await db
    .prepare(
      `INSERT INTO usage_cycles (org_id, cycle, relevant_mentions, keyword_max, updated_at)
       VALUES (?1, ?2, 1, (SELECT COUNT(*) FROM keywords WHERE org_id = ?1 AND muted = 0), ?3)
       ON CONFLICT(org_id, cycle) DO UPDATE SET
         relevant_mentions = relevant_mentions + 1,
         keyword_max = MAX(keyword_max, (SELECT COUNT(*) FROM keywords WHERE org_id = ?1 AND muted = 0)),
         updated_at = ?3`,
    )
    .bind(orgId, cycle, nowMs)
    .run();
}

interface UsageCycleRow {
  cycle: string;
  relevant_mentions: number;
  keyword_max: number;
  billed_units: number;
}

/** Pure pool math shared by the summary and the settlement. */
export function computeBillableUnits(row: Pick<UsageCycleRow, 'relevant_mentions' | 'keyword_max'>): {
  includedMentions: number;
  overageMentions: number;
  billableUnits: number;
} {
  const includedMentions = row.keyword_max * POOL_PER_KEYWORD;
  const overageMentions = Math.max(0, row.relevant_mentions - includedMentions);
  return {
    includedMentions,
    overageMentions,
    billableUnits: Math.floor(overageMentions / MENTION_UNIT_SIZE),
  };
}

export async function getUsageSummary(args: {
  db: D1Database;
  orgId: string;
  nowMs?: number;
}): Promise<UsageSummary> {
  const { db, orgId } = args;
  const nowMs = args.nowMs ?? Date.now();
  const cycle = cycleKey(nowMs);

  const [billing, usage, active] = await Promise.all([
    getOrgBilling(db, orgId),
    db
      .prepare(
        'SELECT cycle, relevant_mentions, keyword_max, billed_units FROM usage_cycles WHERE org_id = ? AND cycle = ?',
      )
      .bind(orgId, cycle)
      .first<UsageCycleRow>(),
    db
      .prepare('SELECT COUNT(*) AS active FROM keywords WHERE org_id = ? AND muted = 0')
      .bind(orgId)
      .first<{ active: number }>(),
  ]);

  const row = usage ?? { cycle, relevant_mentions: 0, keyword_max: 0, billed_units: 0 };
  const { includedMentions, overageMentions, billableUnits } = computeBillableUnits(row);
  return {
    cycle,
    status: billing?.status ?? 'none',
    activeKeywords: active?.active ?? 0,
    keywordMax: row.keyword_max,
    relevantMentions: row.relevant_mentions,
    includedMentions,
    overageMentions,
    // Monotone: pool growth applies prospectively, so units already billed
    // stay counted even when the recomputed figure shrinks below them.
    billableUnits: Math.max(billableUnits, row.billed_units),
    billedUnits: row.billed_units,
  };
}

/** Collapse Polar's subscription statuses to what plan gating needs. */
export function toBillingStatus(polarStatus: string): BillingStatus {
  if (polarStatus === 'active' || polarStatus === 'trialing') return 'active';
  if (polarStatus === 'canceled' || polarStatus === 'revoked') return 'canceled';
  return 'past_due';
}

/**
 * Apply a subscription lifecycle webhook. Polar retries deliveries per event
 * with no ordering guarantee, so two stale arrivals are explicitly ignored:
 * an old subscription's cancel landing after its replacement went active,
 * and a retried 'active' landing after the SAME subscription was canceled
 * (post-revocation reactivations arrive under a new subscription id).
 */
export async function applySubscriptionUpdate(args: {
  db: D1Database;
  orgId: string;
  polarCustomerId: string;
  polarSubscriptionId: string;
  polarStatus: string;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  nowMs?: number;
}): Promise<void> {
  const { db, orgId, polarSubscriptionId } = args;
  const nowMs = args.nowMs ?? Date.now();
  const nextStatus = toBillingStatus(args.polarStatus);
  const existing = await getOrgBilling(db, orgId);
  const previousStatus = existing?.status ?? 'none';
  const storedSubscriptionId = existing?.polar_subscription_id ?? null;

  const staleCrossSubscriptionCancel =
    previousStatus === 'active' &&
    storedSubscriptionId !== null &&
    storedSubscriptionId !== polarSubscriptionId &&
    nextStatus !== 'active';
  const staleSameSubscriptionRevival =
    previousStatus === 'canceled' && storedSubscriptionId === polarSubscriptionId && nextStatus === 'active';
  if (staleCrossSubscriptionCancel || staleSameSubscriptionRevival) return;

  // FIRST-EVER activation baselines the cycle: the free-period keyword peak
  // is not billable for the pool (keyword_max resets to the current count)
  // and accrued free-period overage is marked billed — with CEIL, so a
  // started partial unit is forgiven too (rounding favors the customer).
  // Transition-scoped: dunning recoveries (past_due) and re-subscribes
  // (canceled) were paid service, their usage stays billable. ORDER MATTERS:
  // the baseline lands BEFORE the status flip so the daily billing tick can
  // never observe an active org whose free-period overage is unforgiven.
  if (nextStatus === 'active' && previousStatus === 'none') {
    await db
      .prepare(
        `UPDATE usage_cycles SET
           keyword_max = (SELECT COUNT(*) FROM keywords WHERE org_id = ?1 AND muted = 0),
           billed_units = MAX(billed_units,
             (MAX(0, relevant_mentions - (SELECT COUNT(*) FROM keywords WHERE org_id = ?1 AND muted = 0) * ${POOL_PER_KEYWORD})
              + ${MENTION_UNIT_SIZE - 1}) / ${MENTION_UNIT_SIZE}),
           updated_at = ?2
         WHERE org_id = ?1 AND cycle = ?3`,
      )
      .bind(orgId, nowMs, cycleKey(nowMs))
      .run();
  }

  await db
    .prepare(
      `INSERT INTO org_billing
         (org_id, polar_customer_id, polar_subscription_id, status, current_period_start, current_period_end, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(org_id) DO UPDATE SET
         polar_customer_id = ?2, polar_subscription_id = ?3, status = ?4,
         current_period_start = ?5, current_period_end = ?6, updated_at = ?7`,
    )
    .bind(
      orgId,
      args.polarCustomerId,
      polarSubscriptionId,
      nextStatus,
      args.currentPeriodStart,
      args.currentPeriodEnd,
      nowMs,
    )
    .run();
}

/** The day's keyword-day event for one org, or null when nothing is active.
 *  Identity is (org, day): re-emission is deduped, and a count that changes
 *  later the same day waits until tomorrow (day-granularity sampling). */
export function buildKeywordDayEvent(args: {
  orgId: string;
  day: string;
  activeKeywords: number;
}): PolarEvent | null {
  if (args.activeKeywords <= 0) return null;
  return {
    name: EVENT_KEYWORD_DAYS,
    externalCustomerId: args.orgId,
    externalId: `kwday:${args.orgId}:${args.day}`,
    metadata: { count: args.activeKeywords, date: args.day },
  };
}

/** Mention units not yet projected for a cycle row. Monotone by
 *  construction: units are numbered, numbering never restarts. */
export function buildMentionUnitEvents(args: {
  orgId: string;
  row: UsageCycleRow;
}): { events: PolarEvent[]; targetBilledUnits: number } {
  const { orgId, row } = args;
  const events: PolarEvent[] = [];
  const { billableUnits } = computeBillableUnits(row);
  for (let unit = row.billed_units + 1; unit <= billableUnits; unit++) {
    events.push({
      name: EVENT_MENTION_UNITS,
      externalCustomerId: orgId,
      externalId: `munit:${orgId}:${row.cycle}:${unit}`,
      metadata: { unit, cycle: row.cycle },
    });
  }
  return { events, targetBilledUnits: Math.max(billableUnits, row.billed_units) };
}

/** Polar's ingest accepts batches; chunk conservatively. */
const INGEST_BATCH_MAX = 100;

/**
 * The daily billing tick (scheduler-gated to once per UTC day):
 *
 * 1. HEARTBEAT: upsert the current cycle's keyword high-water for every
 *    actively subscribed org (feeds the mention pool).
 * 2. KEYWORD DAYS: one prorated event per active org with today's count.
 *    A missed day (scheduler down) is an unbilled day, never a made-up one.
 * 3. MENTION UNITS: emit units crossed since the last tick for the current
 *    cycle, and close out prior unsettled cycles (stamping settled_at).
 *    Ordering is crash-safe: ingest first, advance billed_units after
 *    (MAX-guarded, so a concurrent baseline is never clobbered); a crash
 *    re-sends and Polar dedupes on external_id.
 */
export async function runDailyBilling(args: {
  db: D1Database;
  polar: PolarClient;
  nowMs?: number;
}): Promise<{ keywordDayEvents: number; mentionUnitEvents: number; closedCycles: number }> {
  const { db, polar } = args;
  const nowMs = args.nowMs ?? Date.now();
  const currentCycle = cycleKey(nowMs);
  const today = dayKey(nowMs);

  await db
    .prepare(
      `INSERT INTO usage_cycles (org_id, cycle, keyword_max, updated_at)
       SELECT ob.org_id, ?1,
              (SELECT COUNT(*) FROM keywords k WHERE k.org_id = ob.org_id AND k.muted = 0), ?2
       FROM org_billing ob
       WHERE ob.status = 'active'
       ON CONFLICT(org_id, cycle) DO UPDATE SET
         keyword_max = MAX(keyword_max, excluded.keyword_max),
         updated_at = excluded.updated_at`,
    )
    .bind(currentCycle, nowMs)
    .run();

  const { results: activeOrgs } = await db
    .prepare(
      `SELECT ob.org_id AS org_id,
              (SELECT COUNT(*) FROM keywords k WHERE k.org_id = ob.org_id AND k.muted = 0) AS active
       FROM org_billing ob
       WHERE ob.status = 'active'`,
    )
    .all<{ org_id: string; active: number }>();

  const keywordDayEvents = activeOrgs
    .map((org) => buildKeywordDayEvent({ orgId: org.org_id, day: today, activeKeywords: org.active }))
    .filter((event): event is PolarEvent => event !== null);
  for (let i = 0; i < keywordDayEvents.length; i += INGEST_BATCH_MAX) {
    await polar.ingestEvents(keywordDayEvents.slice(i, i + INGEST_BATCH_MAX));
  }

  const { results: cycleRows } = await db
    .prepare(
      `SELECT uc.org_id, uc.cycle, uc.relevant_mentions, uc.keyword_max, uc.billed_units
       FROM usage_cycles uc
       JOIN org_billing ob ON ob.org_id = uc.org_id
       WHERE ob.status = 'active'
         AND (uc.cycle = ?1 OR (uc.cycle < ?1 AND uc.settled_at IS NULL))`,
    )
    .bind(currentCycle)
    .all<UsageCycleRow & { org_id: string }>();

  let mentionUnitEvents = 0;
  let closedCycles = 0;
  for (const row of cycleRows) {
    const isClosed = row.cycle < currentCycle;
    const { events, targetBilledUnits } = buildMentionUnitEvents({ orgId: row.org_id, row });
    if (events.length === 0 && !isClosed) continue;
    await polar.ingestEvents(events);
    mentionUnitEvents += events.length;
    if (isClosed) closedCycles++;
    await db
      .prepare(
        `UPDATE usage_cycles
         SET billed_units = MAX(billed_units, ?1),
             settled_at = CASE WHEN ?2 THEN ?3 ELSE settled_at END,
             updated_at = ?3
         WHERE org_id = ?4 AND cycle = ?5`,
      )
      .bind(targetBilledUnits, isClosed ? 1 : 0, nowMs, row.org_id, row.cycle)
      .run();
  }

  return { keywordDayEvents: keywordDayEvents.length, mentionUnitEvents, closedCycles };
}
