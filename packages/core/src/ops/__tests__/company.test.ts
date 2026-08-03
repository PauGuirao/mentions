import { describe, expect, it } from 'vitest';
import type { CompanyProfile } from '../../schemas';
import {
  composeCompanyContext,
  getCompanyContext,
  getCompanyProfile,
  setCompanyContext,
  setCompanyProfile,
} from '../company';
import { createTestD1, seedOrg } from './d1-sqlite';

const PROFILE: CompanyProfile = {
  name: 'Zernio',
  description: 'Unified social media API for developers.',
  useCases: ['Cross-platform publishing', 'Unified inbox'],
  xAccount: 'zernio',
  linkedinAccount: 'Zernio',
};

describe('composeCompanyContext', () => {
  it('composes name, description, use cases and socials', () => {
    expect(composeCompanyContext(PROFILE)).toBe(
      [
        'Zernio: Unified social media API for developers.',
        'Product use cases:\n- Cross-platform publishing\n- Unified inbox',
        'X/Twitter: @zernio\nLinkedIn: Zernio',
      ].join('\n\n'),
    );
  });

  it('degrades gracefully with empty optional fields', () => {
    expect(
      composeCompanyContext({
        name: 'Zernio',
        description: '',
        useCases: [],
        xAccount: null,
        linkedinAccount: null,
      }),
    ).toBe('Zernio');
  });

  it('strips a pasted leading @ from the X account', () => {
    const context = composeCompanyContext({ ...PROFILE, useCases: [], xAccount: '@zernio' });
    expect(context).toContain('X/Twitter: @zernio');
    expect(context).not.toContain('@@');
  });
});

describe('company context', () => {
  it('round-trips through set/get and defaults to empty', async () => {
    const db = createTestD1();
    await seedOrg(db, 'org_1');
    await expect(getCompanyContext({ db, orgId: 'org_1' })).resolves.toBe('');
    await setCompanyContext({ db, orgId: 'org_1', context: 'We build X for Y.' });
    await expect(getCompanyContext({ db, orgId: 'org_1' })).resolves.toBe('We build X for Y.');
    // Missing org: empty string, not an error.
    await expect(getCompanyContext({ db, orgId: 'org_missing' })).resolves.toBe('');
  });
});

describe('company profile', () => {
  it('round-trips and stores the composed classifier context', async () => {
    const db = createTestD1();
    await seedOrg(db, 'org_1');
    await setCompanyProfile({ db, orgId: 'org_1', profile: PROFILE });

    await expect(getCompanyProfile({ db, orgId: 'org_1' })).resolves.toEqual(PROFILE);
    await expect(getCompanyContext({ db, orgId: 'org_1' })).resolves.toBe(
      composeCompanyContext(PROFILE),
    );
  });

  it('falls back to the org name before a profile is saved', async () => {
    const db = createTestD1();
    await seedOrg(db, 'org_1');
    const profile = await getCompanyProfile({ db, orgId: 'org_1' });
    expect(profile?.name).toBe('org org_1');
    expect(profile?.useCases).toEqual([]);
  });

  it('tolerates malformed use_cases JSON', async () => {
    const db = createTestD1();
    await seedOrg(db, 'org_1');
    await db.prepare("UPDATE orgs SET use_cases = 'not json' WHERE id = 'org_1'").run();
    const profile = await getCompanyProfile({ db, orgId: 'org_1' });
    expect(profile?.useCases).toEqual([]);
  });

  it('returns null for a missing org', async () => {
    const db = createTestD1();
    await expect(getCompanyProfile({ db, orgId: 'org_missing' })).resolves.toBeNull();
  });
});
