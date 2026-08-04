import { describe, expect, it } from 'vitest';
import type { PolarClient, PolarEvent } from '../../polar';
import {
  EVENT_KEYWORD_DAYS,
  EVENT_MENTION_CHARGES,
  applySubscriptionUpdate,
  buildKeywordDayEvent,
  buildMentionChargeEvent,
  computeBillableMentions,
  cycleKey,
  dayKey,
  enforceTrialStops,
  getKeywordLimit,
  getUsageSummary,
  keywordLimitFor,
  TRIAL_MENTION_LIMIT,
  recordBillableMention,
  runDailyBilling,
  toBillingStatus,
} from '../billing';
import { createDbStub } from './stubs';

const AUG_2026 = Date.UTC(2026, 7, 15, 12, 0, 0);

describe('cycleKey', () => {
  it('formats calendar-month UTC with zero padding', () => {
    expect(cycleKey(AUG_2026)).toBe('2026-08');
    expect(cycleKey(Date.UTC(2026, 0, 1))).toBe('2026-01');
    // The last UTC millisecond of a year stays in that year.
    expect(cycleKey(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('2026-12');
  });
});

describe('dayKey', () => {
  it('formats the UTC day with zero padding', () => {
    expect(dayKey(AUG_2026)).toBe('2026-08-15');
    expect(dayKey(Date.UTC(2026, 0, 1))).toBe('2026-01-01');
  });
});

describe('computeBillableMentions', () => {
  it('bills every mention past the flat free allowance', () => {
    const result = computeBillableMentions({ matched_mentions: 3700 });
    expect(result).toEqual({ includedMentions: 100, overageMentions: 3600, billableMentions: 3600 });
  });

  it('bills nothing inside the free allowance', () => {
    expect(computeBillableMentions({ matched_mentions: 99 }).billableMentions).toBe(0);
    expect(computeBillableMentions({ matched_mentions: 100 }).billableMentions).toBe(0);
    expect(computeBillableMentions({ matched_mentions: 101 }).billableMentions).toBe(1);
  });
});

describe('keyword limits', () => {
  it('maps plan status to capacity', () => {
    expect(keywordLimitFor('none')).toBe(2);
    expect(keywordLimitFor('canceled')).toBe(2);
    expect(keywordLimitFor('past_due')).toBe(2);
    expect(keywordLimitFor('active')).toBe(500);
  });

  it('reads the org status for the limit (missing row = free)', async () => {
    const { db } = createDbStub();
    expect(await getKeywordLimit({ db, orgId: 'org_1' })).toBe(2);
    const { db: paidDb } = createDbStub((query) =>
      query.sql.includes('FROM org_billing') ? { first: { status: 'active', polar_subscription_id: 's' } } : {},
    );
    expect(await getKeywordLimit({ db: paidDb, orgId: 'org_1' })).toBe(500);
  });
});

describe('recordBillableMention', () => {
  it('inserts the ledger row then increments the cycle counter', async () => {
    const { db, queries } = createDbStub();
    await recordBillableMention({ db, orgId: 'org_1', mentionMatchId: 'mm_1', nowMs: AUG_2026 });

    expect(queries[0]!.sql).toContain('INSERT OR IGNORE INTO billable_mentions');
    expect(queries[0]!.params).toEqual(['mm_1', 'org_1', '2026-08', AUG_2026]);
    expect(queries[1]!.sql).toContain('matched_mentions = matched_mentions + 1');
    // A fresh cycle must never sit at keyword_max 0 (pool 0 would make every
    // mention billable overage), so the upsert maintains the high-water too.
    expect(queries[1]!.sql).toContain('MAX(keyword_max');
  });

  it('is a no-op when the match was already counted (redelivery)', async () => {
    const { db, queries } = createDbStub((query) =>
      query.sql.includes('billable_mentions') ? { changes: 0 } : {},
    );
    await recordBillableMention({ db, orgId: 'org_1', mentionMatchId: 'mm_1', nowMs: AUG_2026 });
    expect(queries).toHaveLength(1);
  });
});

describe('toBillingStatus', () => {
  it('collapses Polar statuses to gating states', () => {
    expect(toBillingStatus('active')).toBe('active');
    expect(toBillingStatus('trialing')).toBe('active');
    expect(toBillingStatus('canceled')).toBe('canceled');
    expect(toBillingStatus('revoked')).toBe('canceled');
    expect(toBillingStatus('past_due')).toBe('past_due');
    expect(toBillingStatus('incomplete')).toBe('past_due');
  });
});

describe('applySubscriptionUpdate', () => {
  const baseArgs = {
    orgId: 'org_1',
    polarCustomerId: 'cus_1',
    polarSubscriptionId: 'sub_1',
    currentPeriodStart: AUG_2026,
    currentPeriodEnd: AUG_2026 + 30 * 86_400_000,
    nowMs: AUG_2026,
  };

  const billingRow = (status: string, subId: string | null) =>
    ({ first: { status, polar_subscription_id: subId } });

  it('baselines the cycle on FIRST activation only, with ceil rounding, BEFORE the status flip', async () => {
    const { db, queries } = createDbStub(); // org_billing miss -> previous status 'none'
    await applySubscriptionUpdate({ db, ...baseArgs, polarStatus: 'active' });

    const baselineIdx = queries.findIndex((q) => q.sql.includes('UPDATE usage_cycles'));
    const upsertIdx = queries.findIndex((q) => q.sql.includes('INSERT INTO org_billing'));
    expect(baselineIdx).toBeGreaterThan(-1);
    // Ordering: the daily tick must never observe active + unforgiven usage.
    expect(baselineIdx).toBeLessThan(upsertIdx);

    const baseline = queries[baselineIdx]!;
    // Every free-period billable mention is marked projected at activation.
    expect(baseline.sql).toContain('billed_units = MAX(billed_units, MAX(0, matched_mentions - 100))');
    expect(baseline.params).toEqual(['org_1', AUG_2026, '2026-08']);
  });

  it.each([
    ['past_due', 'dunning recovery keeps accrued usage billable'],
    ['canceled', 're-subscribing keeps accrued usage billable'],
    ['active', 'renewals never re-baseline'],
  ])('does not baseline on %s -> active', async (previous) => {
    const { db, queries } = createDbStub((query) =>
      query.sql.includes('FROM org_billing') ? billingRow(previous, 'sub_1') : {},
    );
    await applySubscriptionUpdate({ db, ...baseArgs, polarStatus: 'active' });
    expect(queries.some((q) => q.sql.includes('UPDATE usage_cycles'))).toBe(false);
  });

  it('ignores a stale cancel for a different (replaced) subscription', async () => {
    const { db, queries } = createDbStub((query) =>
      query.sql.includes('FROM org_billing') ? billingRow('active', 'sub_2') : {},
    );
    await applySubscriptionUpdate({ db, ...baseArgs, polarStatus: 'revoked' }); // sub_1 != sub_2
    expect(queries.some((q) => q.sql.includes('INSERT INTO org_billing'))).toBe(false);
  });

  it('ignores a stale active retry for the same canceled subscription', async () => {
    const { db, queries } = createDbStub((query) =>
      query.sql.includes('FROM org_billing') ? billingRow('canceled', 'sub_1') : {},
    );
    await applySubscriptionUpdate({ db, ...baseArgs, polarStatus: 'active' });
    expect(queries.some((q) => q.sql.includes('INSERT INTO org_billing'))).toBe(false);
  });

  it('accepts a replacement subscription going active after a cancel', async () => {
    const { db, queries } = createDbStub((query) =>
      query.sql.includes('FROM org_billing') ? billingRow('canceled', 'sub_0') : {},
    );
    await applySubscriptionUpdate({ db, ...baseArgs, polarStatus: 'active' }); // new id sub_1
    const upsert = queries.find((q) => q.sql.includes('INSERT INTO org_billing'));
    expect(upsert).toBeDefined();
    expect(upsert!.params[3]).toBe('active');
    // Not a first-ever activation: no forgiveness.
    expect(queries.some((q) => q.sql.includes('UPDATE usage_cycles'))).toBe(false);
  });

  it('records a cancellation of the current subscription', async () => {
    const { db, queries } = createDbStub((query) =>
      query.sql.includes('FROM org_billing') ? billingRow('active', 'sub_1') : {},
    );
    await applySubscriptionUpdate({ db, ...baseArgs, polarStatus: 'canceled' });
    const upsert = queries.find((q) => q.sql.includes('INSERT INTO org_billing'));
    expect(upsert!.params[3]).toBe('canceled');
  });
});

describe('getUsageSummary', () => {
  it('returns zeroed usage for an org with no cycle row', async () => {
    const { db } = createDbStub((query) =>
      query.sql.includes('COUNT(*)') ? { first: { active: 1 } } : {},
    );
    const summary = await getUsageSummary({ db, orgId: 'org_1', nowMs: AUG_2026 });
    expect(summary).toEqual({
      cycle: '2026-08',
      status: 'none',
      activeKeywords: 1,
      keywordMax: 0,
      matchedMentions: 0,
      includedMentions: 100,
      overageMentions: 0,
      billableMentions: 0,
      billedMentions: 0,
      trial: null,
    });
  });

  it('derives pool and overage from the cycle row', async () => {
    const { db } = createDbStub((query) => {
      if (query.sql.includes('COUNT(*)')) return { first: { active: 3 } };
      if (query.sql.includes('usage_cycles')) {
        return { first: { cycle: '2026-08', matched_mentions: 3700, keyword_max: 3, billed_units: 1 } };
      }
      return { first: { status: 'active', polar_subscription_id: 'sub_1' } };
    });
    const summary = await getUsageSummary({ db, orgId: 'org_1', nowMs: AUG_2026 });
    expect(summary.includedMentions).toBe(100);
    expect(summary.overageMentions).toBe(3600);
    expect(summary.billableMentions).toBe(3600);
    expect(summary.billedMentions).toBe(1);
    expect(summary.status).toBe('active');
  });
});

describe('buildKeywordDayEvent', () => {
  it('emits one prorated event per org-day', () => {
    const event = buildKeywordDayEvent({ orgId: 'org_1', day: '2026-08-15', activeKeywords: 3 });
    expect(event).toEqual({
      name: EVENT_KEYWORD_DAYS,
      externalCustomerId: 'org_1',
      externalId: 'kwday:org_1:2026-08-15',
      metadata: { count: 3, date: '2026-08-15' },
    });
  });

  it('skips orgs with no active keywords', () => {
    expect(buildKeywordDayEvent({ orgId: 'org_1', day: '2026-08-15', activeKeywords: 0 })).toBeNull();
  });
});

describe('buildMentionChargeEvent', () => {
  it('emits one delta event covering the unprojected mention range', () => {
    const row = { cycle: '2026-08', matched_mentions: 3700, keyword_max: 3, billed_units: 600 };
    const { event, targetBilledMentions } = buildMentionChargeEvent({ orgId: 'org_1', row });
    expect(targetBilledMentions).toBe(3600);
    expect(event).toEqual({
      name: EVENT_MENTION_CHARGES,
      externalCustomerId: 'org_1',
      externalId: 'mchg:org_1:2026-08:601-3600',
      metadata: { count: 3000, cycle: '2026-08' },
    });
  });

  it('never regresses below already-projected mentions', () => {
    // Monotone rule (e.g. after the first-activation forgiveness baseline).
    const grown = { cycle: '2026-08', matched_mentions: 3700, keyword_max: 5, billed_units: 4000 };
    const { event, targetBilledMentions } = buildMentionChargeEvent({ orgId: 'org_1', row: grown });
    expect(event).toBeNull();
    expect(targetBilledMentions).toBe(4000);
  });
});

describe('runDailyBilling', () => {
  const currentCycleRow = {
    org_id: 'org_1',
    cycle: '2026-08',
    matched_mentions: 3700,
    keyword_max: 3,
    billed_units: 0,
  };
  const closedCycleRow = { ...currentCycleRow, cycle: '2026-07', billed_units: 1 };

  function stubPolar(): { polar: PolarClient; ingested: PolarEvent[][] } {
    const ingested: PolarEvent[][] = [];
    const polar = {
      ingestEvents: async (events: PolarEvent[]) => {
        ingested.push(events);
        return { inserted: events.length, duplicates: 0 };
      },
    } as unknown as PolarClient;
    return { polar, ingested };
  }

  it('emits keyword-day events, current-cycle units, and closes prior cycles', async () => {
    const { db, queries } = createDbStub((query) => {
      if (query.sql.includes('FROM org_billing ob') && query.sql.includes('AS active')) {
        return { results: [{ org_id: 'org_1', active: 3 }] };
      }
      if (query.sql.includes('FROM usage_cycles uc')) {
        return { results: [currentCycleRow, closedCycleRow] };
      }
      return {};
    });
    const { polar, ingested } = stubPolar();

    const result = await runDailyBilling({ db, polar, nowMs: AUG_2026 });
    expect(result).toEqual({ keywordDayEvents: 1, mentionChargeEvents: 2, closedCycles: 1 });

    // Batch 1: the day's keyword-day events; then one delta per cycle.
    expect(ingested[0]!.map((e) => e.externalId)).toEqual(['kwday:org_1:2026-08-15']);
    expect(ingested[1]!.map((e) => e.externalId)).toEqual(['mchg:org_1:2026-08:1-3600']);
    expect(ingested[1]![0]!.metadata).toEqual({ count: 3600, cycle: '2026-08' });
    expect(ingested[2]!.map((e) => e.externalId)).toEqual(['mchg:org_1:2026-07:2-3600']);

    // Heartbeat seeds/raises the current cycle's pool high-water first.
    expect(queries[0]!.sql).toContain('MAX(keyword_max, excluded.keyword_max)');
    expect(queries[0]!.params[0]).toBe('2026-08');

    // The closed cycle is stamped settled; the current one is not.
    const updates = queries.filter((q) => q.sql.includes('billed_units = MAX(billed_units, ?1)'));
    expect(updates).toHaveLength(2);
    expect(updates[0]!.params).toEqual([3600, 0, AUG_2026, 'org_1', '2026-08']);
    expect(updates[1]!.params).toEqual([3600, 1, AUG_2026, 'org_1', '2026-07']);
  });

  it('skips the units write when a current cycle has nothing new', async () => {
    const settled = { ...currentCycleRow, billed_units: 3600 };
    const { db, queries } = createDbStub((query) => {
      if (query.sql.includes('FROM org_billing ob') && query.sql.includes('AS active')) {
        return { results: [] };
      }
      if (query.sql.includes('FROM usage_cycles uc')) return { results: [settled] };
      return {};
    });
    const { polar, ingested } = stubPolar();

    const result = await runDailyBilling({ db, polar, nowMs: AUG_2026 });
    expect(result).toEqual({ keywordDayEvents: 0, mentionChargeEvents: 0, closedCycles: 0 });
    expect(ingested).toHaveLength(0);
    expect(queries.some((q) => q.sql.includes('billed_units = MAX'))).toBe(false);
  });

  it('does not advance billed_units when ingest throws', async () => {
    const { db, queries } = createDbStub((query) => {
      if (query.sql.includes('FROM org_billing ob') && query.sql.includes('AS active')) {
        return { results: [] };
      }
      if (query.sql.includes('FROM usage_cycles uc')) return { results: [currentCycleRow] };
      return {};
    });
    const polar = {
      ingestEvents: async () => {
        throw new Error('polar down');
      },
    } as unknown as PolarClient;

    await expect(runDailyBilling({ db, polar, nowMs: AUG_2026 })).rejects.toThrow('polar down');
    expect(queries.some((q) => q.sql.includes('billed_units = MAX'))).toBe(false);
  });
});

describe('trial lifecycle', () => {
  const NOW = 1_785_800_000_000;

  async function seedTrialOrg(db: D1Database, orgId: string, trialEndsAt: number) {
    await db
      .prepare("INSERT INTO orgs (id, name, created_at, trial_ends_at) VALUES (?1, ?2, 0, ?3)")
      .bind(orgId, `org ${orgId}`, trialEndsAt)
      .run();
    await db
      .prepare(
        "INSERT INTO keywords (id, org_id, term, normalized_term, kind, muted, created_at) VALUES (?1, ?2, 'zernio', 'zernio', 'brand', 0, 0)",
      )
      .bind(`kw_${orgId}`, orgId)
      .run();
  }

  it('reports a running trial and expires on time', async () => {
    const { createTestD1 } = await import('./d1-sqlite');
    const db = createTestD1();
    await seedTrialOrg(db, 'org_t1', NOW + 1000);

    const running = await getUsageSummary({ db, orgId: 'org_t1', nowMs: NOW });
    expect(running.trial).toEqual({
      endsAt: NOW + 1000,
      mentionsUsed: 0,
      mentionsLimit: TRIAL_MENTION_LIMIT,
      expired: false,
    });

    const over = await getUsageSummary({ db, orgId: 'org_t1', nowMs: NOW + 2000 });
    expect(over.trial?.expired).toBe(true);
    await expect(getKeywordLimit({ db, orgId: 'org_t1' })).resolves.toBe(0);
  });

  it('enforceTrialStops mutes expired trials only', async () => {
    const { createTestD1 } = await import('./d1-sqlite');
    const db = createTestD1();
    await seedTrialOrg(db, 'org_dead', NOW - 1000);
    await seedTrialOrg(db, 'org_alive', NOW + 999_999);
    // Grandfathered org: no trial, never stopped.
    await db
      .prepare("INSERT INTO orgs (id, name, created_at) VALUES ('org_legacy', 'legacy', 0)")
      .run();
    await db
      .prepare(
        "INSERT INTO keywords (id, org_id, term, normalized_term, kind, muted, created_at) VALUES ('kw_legacy', 'org_legacy', 'a b', 'a b', 'topic', 0, 0)",
      )
      .run();

    const { stoppedKeywords } = await enforceTrialStops({ db, nowMs: NOW });
    expect(stoppedKeywords).toBe(1);
    const { results } = await db
      .prepare('SELECT org_id, muted FROM keywords ORDER BY org_id')
      .all<{ org_id: string; muted: number }>();
    expect(results).toEqual([
      { org_id: 'org_alive', muted: 0 },
      { org_id: 'org_dead', muted: 1 },
      { org_id: 'org_legacy', muted: 0 },
    ]);
    // Idempotent re-run.
    await expect(enforceTrialStops({ db, nowMs: NOW })).resolves.toEqual({ stoppedKeywords: 0 });
  });

  it('mention allowance exhaustion expires the trial early', async () => {
    const { createTestD1 } = await import('./d1-sqlite');
    const db = createTestD1();
    await seedTrialOrg(db, 'org_m', NOW + 999_999);
    const inserts = [];
    for (let i = 0; i < TRIAL_MENTION_LIMIT; i++) {
      inserts.push(
        db
          .prepare(
            "INSERT INTO billable_mentions (mention_match_id, org_id, cycle, created_at) VALUES (?1, 'org_m', '2026-08', 0)",
          )
          .bind(`mm_${i}`)
          .run(),
      );
    }
    await Promise.all(inserts);
    const summary = await getUsageSummary({ db, orgId: 'org_m', nowMs: NOW });
    expect(summary.trial?.mentionsUsed).toBe(TRIAL_MENTION_LIMIT);
    expect(summary.trial?.expired).toBe(true);
    await expect(enforceTrialStops({ db, nowMs: NOW })).resolves.toEqual({ stoppedKeywords: 1 });
  });

  it('activation unmutes a stopped org', async () => {
    const { createTestD1 } = await import('./d1-sqlite');
    const db = createTestD1();
    await seedTrialOrg(db, 'org_up', NOW - 1000);
    await enforceTrialStops({ db, nowMs: NOW });
    await applySubscriptionUpdate({
      db,
      orgId: 'org_up',
      polarCustomerId: 'cus_1',
      polarSubscriptionId: 'sub_1',
      polarStatus: 'active',
      currentPeriodStart: NOW,
      currentPeriodEnd: NOW + 1,
      nowMs: NOW,
    });
    const row = await db
      .prepare("SELECT muted FROM keywords WHERE org_id = 'org_up'")
      .first<{ muted: number }>();
    expect(row?.muted).toBe(0);
    // Active subscription hides trial fields entirely.
    const summary = await getUsageSummary({ db, orgId: 'org_up', nowMs: NOW });
    expect(summary.trial).toBeNull();
  });
});
