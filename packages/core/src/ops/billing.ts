/**
 * Billing operations. Pricing model (see CLAUDE.md "Billing"):
 *   - Keywords are PRORATED PER DAY: one event per org per UTC day carrying
 *     that day's active keyword count (Polar Sum meter at EUR 5/30 per
 *     keyword-day). A missed day is an unbilled day.
 *   - Mentions: the first FREE_MENTIONS_PER_CYCLE mentions each cycle are
 *     free (flat, org-wide; keywords bundle nothing), then EVERY matched
 *     mention bills at EUR 0.008 (EUR 8 per 1,000) whether the classifier
 *     scored it relevant or filtered it as noise. The daily tick
 *     emits one delta event per org-cycle carrying the newly billable count
 *     (Polar Sum meter); billed_units stores the mention count already
 *     projected and only ever grows.
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

// DELIBERATELY NOT PORTED TO DRIZZLE: every statement here is either a
// MAX-guarded/capacity-gated write or an upsert whose exact SQL shape is the
// correctness argument (billing must never over-bill). Raw prepared
// statements keep that reviewable as SQL. See CLAUDE.md, Stack.
/** Flat free allowance per cycle; keywords bundle no mentions. */
export const FREE_MENTIONS_PER_CYCLE = 100;
export const FREE_KEYWORD_LIMIT = 2;
/** Self-serve ceiling; past it is an enterprise conversation, not a gate on
 *  paying (mirrors the pricing page split). */
export const SELF_SERVE_KEYWORD_LIMIT = 500;
/** Self-serve trial: full product, no card, until either runs out. */
export const TRIAL_DAYS = 3;
/** Counts EVERY matched mention (billing basis, invariant 7), not just the
 *  relevant ones — so this is ~3-5x more permissive than the same number was
 *  under relevance-only billing. 100 would have ended a 3-day trial in
 *  minutes once noise started counting. */
export const TRIAL_MENTION_LIMIT = 1_000;
export const TRIAL_MS = TRIAL_DAYS * 86_400_000;

/** Polar event names; the dashboard meters filter on these exact strings. */
export const EVENT_KEYWORD_DAYS = 'keyword_days';
export const EVENT_MENTION_CHARGES = 'mention_charges';

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

/** Subscribed orgs pay per keyword up to the self-serve ceiling; beyond it
 *  is enterprise territory (custom limits, not a bigger checkbox). */
export function keywordLimitFor(status: BillingStatus): number | null {
  return status === 'active' ? SELF_SERVE_KEYWORD_LIMIT : FREE_KEYWORD_LIMIT;
}

/** The org's current keyword capacity. The CHECK against it must live in the
 *  same SQL statement as the write (see createKeyword) — a separate
 *  read-then-write races concurrent requests past the limit. */
export async function getKeywordLimit(args: {
  db: D1Database;
  orgId: string;
}): Promise<number | null> {
  const row = await getOrgBilling(args.db, args.orgId);
  const limit = keywordLimitFor(row?.status ?? 'none');
  if (limit === null) return null;
  // An expired trial is a full stop: no new keywords until a card is added.
  const trial = await getTrialState({
    db: args.db,
    orgId: args.orgId,
    status: row?.status ?? 'none',
  });
  return trial?.expired ? 0 : limit;
}

/** Trial fields for the org, or null when the trial machinery does not apply
 *  (active subscription, or a grandfathered org with trial_ends_at NULL). */
export async function getTrialState(args: {
  db: D1Database;
  orgId: string;
  status: BillingStatus;
  nowMs?: number;
}): Promise<UsageSummary['trial']> {
  if (args.status === 'active') return null;
  const nowMs = args.nowMs ?? Date.now();
  const org = await args.db
    .prepare('SELECT trial_ends_at FROM orgs WHERE id = ?')
    .bind(args.orgId)
    .first<{ trial_ends_at: number | null }>();
  if (!org || org.trial_ends_at === null) return null;
  const used = await args.db
    .prepare('SELECT COUNT(*) AS n FROM billable_mentions WHERE org_id = ?')
    .bind(args.orgId)
    .first<{ n: number }>();
  const mentionsUsed = used?.n ?? 0;
  return {
    endsAt: org.trial_ends_at,
    mentionsUsed,
    mentionsLimit: TRIAL_MENTION_LIMIT,
    expired: nowMs >= org.trial_ends_at || mentionsUsed >= TRIAL_MENTION_LIMIT,
  };
}

/**
 * Full stop for finished trials: mute every keyword of a trial-era org that
 * has no active subscription and is past its time or mention allowance.
 * Muting drops the org's terms from the polling registry and the matcher's
 * fan-out, so the whole pipeline halts for it. Idempotent; the scheduler
 * calls this every tick. Upgrading unmutes (applySubscriptionUpdate).
 */
export async function enforceTrialStops(args: {
  db: D1Database;
  nowMs?: number;
}): Promise<{ stoppedKeywords: number }> {
  const nowMs = args.nowMs ?? Date.now();
  const result = await args.db
    .prepare(
      `UPDATE keywords SET muted = 1
       WHERE muted = 0 AND org_id IN (
         SELECT o.id FROM orgs o
         LEFT JOIN org_billing ob ON ob.org_id = o.id
         WHERE o.trial_ends_at IS NOT NULL
           AND (ob.status IS NULL OR ob.status != 'active')
           AND (o.trial_ends_at <= ?1
                OR (SELECT COUNT(*) FROM billable_mentions bm WHERE bm.org_id = o.id) >= ${TRIAL_MENTION_LIMIT})
       )`,
    )
    .bind(nowMs)
    .run();
  return { stoppedKeywords: result.meta.changes ?? 0 };
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
 * Count one matched mention, exactly once per match. Called for EVERY scored
 * match, relevant or filtered — the classifier's threshold gates delivery,
 * not billing. The billable_mentions PK is the idempotency; queue
 * redeliveries and the classifier's repair path both funnel here safely. A
 * crash between the two statements loses one count: deliberate (under-bill,
 * never over-bill).
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
      `INSERT INTO usage_cycles (org_id, cycle, matched_mentions, keyword_max, updated_at)
       VALUES (?1, ?2, 1, (SELECT COUNT(*) FROM keywords WHERE org_id = ?1 AND muted = 0), ?3)
       ON CONFLICT(org_id, cycle) DO UPDATE SET
         matched_mentions = matched_mentions + 1,
         keyword_max = MAX(keyword_max, (SELECT COUNT(*) FROM keywords WHERE org_id = ?1 AND muted = 0)),
         updated_at = ?3`,
    )
    .bind(orgId, cycle, nowMs)
    .run();
}

interface UsageCycleRow {
  cycle: string;
  matched_mentions: number;
  keyword_max: number;
  billed_units: number;
}

/** Pure allowance math shared by the summary and the settlement: every
 *  matched mention past the flat free allowance is individually billable,
 *  whatever the classifier scored it. */
export function computeBillableMentions(row: Pick<UsageCycleRow, 'matched_mentions'>): {
  includedMentions: number;
  overageMentions: number;
  billableMentions: number;
} {
  const includedMentions = FREE_MENTIONS_PER_CYCLE;
  const overageMentions = Math.max(0, row.matched_mentions - includedMentions);
  return { includedMentions, overageMentions, billableMentions: overageMentions };
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
        'SELECT cycle, matched_mentions, keyword_max, billed_units FROM usage_cycles WHERE org_id = ? AND cycle = ?',
      )
      .bind(orgId, cycle)
      .first<UsageCycleRow>(),
    db
      .prepare('SELECT COUNT(*) AS active FROM keywords WHERE org_id = ? AND muted = 0')
      .bind(orgId)
      .first<{ active: number }>(),
  ]);

  const row = usage ?? { cycle, matched_mentions: 0, keyword_max: 0, billed_units: 0 };
  const { includedMentions, overageMentions, billableMentions } = computeBillableMentions(row);
  const status = billing?.status ?? 'none';
  return {
    cycle,
    status,
    activeKeywords: active?.active ?? 0,
    keywordMax: row.keyword_max,
    matchedMentions: row.matched_mentions,
    includedMentions,
    overageMentions,
    // Monotone: mentions already projected stay counted even when the
    // recomputed figure shrinks below them (e.g. after a baseline).
    billableMentions: Math.max(billableMentions, row.billed_units),
    billedMentions: row.billed_units,
    trial: await getTrialState({ db, orgId, status, nowMs }),
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

  // FIRST-EVER activation baselines the cycle: keyword_max resets to the
  // current count and every free-period billable mention is marked already
  // projected, so paid metering starts at zero from the subscription moment.
  // Transition-scoped: dunning recoveries (past_due) and re-subscribes
  // (canceled) were paid service, their usage stays billable. ORDER MATTERS:
  // the baseline lands BEFORE the status flip so the daily billing tick can
  // never observe an active org whose free-period usage is unforgiven.
  if (nextStatus === 'active' && previousStatus === 'none') {
    await db
      .prepare(
        `UPDATE usage_cycles SET
           keyword_max = (SELECT COUNT(*) FROM keywords WHERE org_id = ?1 AND muted = 0),
           billed_units = MAX(billed_units, MAX(0, matched_mentions - ${FREE_MENTIONS_PER_CYCLE})),
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

  // Becoming active lifts a trial/cancel full stop: unmute everything so the
  // pipeline resumes. (Coarse by design; a manually muted keyword riding
  // along is a lesser evil than a paying org staying dark.)
  if (nextStatus === 'active' && previousStatus !== 'active') {
    await db.prepare('UPDATE keywords SET muted = 0 WHERE org_id = ?').bind(orgId).run();
  }
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

/** The delta of billable mentions not yet projected for a cycle row, as ONE
 *  event whose external id encodes the covered mention range. Monotone by
 *  construction: mentions are numbered, numbering never restarts, so a
 *  crash-and-retry re-emits the identical id and Polar dedupes it. */
export function buildMentionChargeEvent(args: {
  orgId: string;
  row: UsageCycleRow;
}): { event: PolarEvent | null; targetBilledMentions: number } {
  const { orgId, row } = args;
  const { billableMentions } = computeBillableMentions(row);
  if (billableMentions <= row.billed_units) {
    return { event: null, targetBilledMentions: row.billed_units };
  }
  const count = billableMentions - row.billed_units;
  return {
    event: {
      name: EVENT_MENTION_CHARGES,
      externalCustomerId: orgId,
      externalId: `mchg:${orgId}:${row.cycle}:${row.billed_units + 1}-${billableMentions}`,
      metadata: { count, cycle: row.cycle },
    },
    targetBilledMentions: billableMentions,
  };
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
}): Promise<{ keywordDayEvents: number; mentionChargeEvents: number; closedCycles: number }> {
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
      `SELECT uc.org_id, uc.cycle, uc.matched_mentions, uc.keyword_max, uc.billed_units
       FROM usage_cycles uc
       JOIN org_billing ob ON ob.org_id = uc.org_id
       WHERE ob.status = 'active'
         AND (uc.cycle = ?1 OR (uc.cycle < ?1 AND uc.settled_at IS NULL))`,
    )
    .bind(currentCycle)
    .all<UsageCycleRow & { org_id: string }>();

  let mentionChargeEvents = 0;
  let closedCycles = 0;
  for (const row of cycleRows) {
    const isClosed = row.cycle < currentCycle;
    const { event, targetBilledMentions } = buildMentionChargeEvent({ orgId: row.org_id, row });
    if (event === null && !isClosed) continue;
    if (event !== null) {
      await polar.ingestEvents([event]);
      mentionChargeEvents++;
    }
    await db
      .prepare(
        `UPDATE usage_cycles
         SET billed_units = MAX(billed_units, ?1),
             settled_at = CASE WHEN ?2 THEN ?3 ELSE settled_at END,
             updated_at = ?3
         WHERE org_id = ?4 AND cycle = ?5`,
      )
      .bind(targetBilledMentions, isClosed ? 1 : 0, nowMs, row.org_id, row.cycle)
      .run();
    if (isClosed) closedCycles++;
  }

  return { keywordDayEvents: keywordDayEvents.length, mentionChargeEvents, closedCycles };
}
