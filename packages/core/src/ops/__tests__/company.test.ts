import { describe, expect, it } from 'vitest';
import type { CompanyProfile } from '../../schemas';
import { composeCompanyContext, getCompanyProfile, setCompanyProfile } from '../company';
import { createDbStub } from './stubs';

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

describe('getCompanyProfile', () => {
  it('maps the row, preferring brand_name and parsing use_cases JSON', async () => {
    const { db } = createDbStub(() => ({
      first: {
        name: "pau's workspace",
        brand_name: 'Zernio',
        description: 'desc',
        use_cases: '["a","b"]',
        x_account: null,
        linkedin_account: 'Zernio',
      },
    }));
    await expect(getCompanyProfile({ db, orgId: 'org_1' })).resolves.toEqual({
      name: 'Zernio',
      description: 'desc',
      useCases: ['a', 'b'],
      xAccount: null,
      linkedinAccount: 'Zernio',
    });
  });

  it('falls back to org name and tolerates malformed use_cases', async () => {
    const { db } = createDbStub(() => ({
      first: {
        name: "pau's workspace",
        brand_name: null,
        description: '',
        use_cases: 'not json',
        x_account: null,
        linkedin_account: null,
      },
    }));
    const profile = await getCompanyProfile({ db, orgId: 'org_1' });
    expect(profile?.name).toBe("pau's workspace");
    expect(profile?.useCases).toEqual([]);
  });
});

describe('setCompanyProfile', () => {
  it('writes the fields and the composed classifier context in one update', async () => {
    const { db, queries } = createDbStub();
    await setCompanyProfile({ db, orgId: 'org_1', profile: PROFILE });
    expect(queries).toHaveLength(1);
    const query = queries[0];
    expect(query?.sql).toContain('UPDATE orgs SET brand_name');
    expect(query?.params).toEqual([
      'Zernio',
      'Unified social media API for developers.',
      '["Cross-platform publishing","Unified inbox"]',
      'zernio',
      'Zernio',
      composeCompanyContext(PROFILE),
      'org_1',
    ]);
  });
});
