import { describe, expect, it } from 'vitest';
import {
  buildBrandAnalysisMessages,
  buildBrandJsonRetryMessages,
  completeOnboarding,
  extractAiText,
  extractFaviconUrl,
  extractSiteText,
  googleFaviconUrl,
  parseBrandAnalysisResponse,
  validateWebsiteUrl,
} from '../brand';
import { DuplicateKeywordError, createKeyword } from '../keywords';
import { createTestD1, seedOrg } from './d1-sqlite';

const VALID_REPLY = JSON.stringify({
  brandName: 'Resend',
  context: 'Resend is an email API for developers.',
  topics: ['email api', 'transactional email'],
  competitors: ['SendGrid', 'Postmark'],
});

describe('buildBrandAnalysisMessages', () => {
  it('includes website and page text in the user message', () => {
    const messages = buildBrandAnalysisMessages({
      website: 'https://resend.com',
      pageText: 'Email for developers',
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.content).toContain('https://resend.com');
    expect(messages[1]?.content).toContain('Email for developers');
  });
});

describe('buildBrandJsonRetryMessages', () => {
  it('echoes the bad reply before the nudge', () => {
    const base = buildBrandAnalysisMessages({ website: 'https://x.dev', pageText: 'x' });
    const retry = buildBrandJsonRetryMessages({ messages: base, badReply: 'not json' });
    expect(retry).toHaveLength(4);
    expect(retry[2]).toEqual({ role: 'assistant', content: 'not json' });
    expect(retry[3]?.content).toMatch(/ONLY the JSON object/);
  });

  it('skips the echo when the bad reply is blank', () => {
    const base = buildBrandAnalysisMessages({ website: 'https://x.dev', pageText: 'x' });
    expect(buildBrandJsonRetryMessages({ messages: base, badReply: '  ' })).toHaveLength(3);
  });
});

describe('extractAiText', () => {
  it('handles plain strings, { response } and chat.completion envelopes', () => {
    expect(extractAiText('hi')).toBe('hi');
    expect(extractAiText({ response: 'hi' })).toBe('hi');
    expect(extractAiText({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
    expect(extractAiText({ unexpected: true })).toBeNull();
    expect(extractAiText(null)).toBeNull();
  });
});

describe('parseBrandAnalysisResponse', () => {
  it('parses a clean reply', () => {
    const parsed = parseBrandAnalysisResponse(VALID_REPLY);
    expect(parsed).not.toBeNull();
    expect(parsed?.brandName).toBe('Resend');
    expect(parsed?.topics).toEqual(['email api', 'transactional email']);
    expect(parsed?.competitors).toEqual(['SendGrid', 'Postmark']);
  });

  it('tolerates fences and prose around the JSON', () => {
    const parsed = parseBrandAnalysisResponse(`Sure! Here it is:\n\`\`\`json\n${VALID_REPLY}\n\`\`\``);
    expect(parsed?.brandName).toBe('Resend');
  });

  it('slices over-long arrays to 2 and drops junk entries', () => {
    const parsed = parseBrandAnalysisResponse(
      JSON.stringify({
        brandName: 'X',
        context: 'c',
        topics: ['one topic', 42, ' ', 'two topic', 'three topic'],
        competitors: ['A corp', 'B corp', 'C corp'],
      }),
    );
    expect(parsed?.topics).toEqual(['one topic', 'two topic']);
    expect(parsed?.competitors).toEqual(['A corp', 'B corp']);
  });

  it('rejects replies without a brand name or without suggestions', () => {
    expect(parseBrandAnalysisResponse(JSON.stringify({ context: 'c', topics: ['a b'], competitors: ['x y'] }))).toBeNull();
    expect(
      parseBrandAnalysisResponse(
        JSON.stringify({ brandName: 'X', context: 'c', topics: [], competitors: ['x y'] }),
      ),
    ).toBeNull();
    expect(parseBrandAnalysisResponse('no json at all')).toBeNull();
  });
});

describe('extractSiteText', () => {
  it('front-loads title and meta description, strips scripts and tags', () => {
    const html = `<html><head>
      <title>Resend &amp; Friends</title>
      <meta name="description" content="Email API for developers">
      <script>var tracking = "should not appear";</script>
      <style>.x { color: red }</style>
    </head><body><h1>Send email</h1><p>reliably</p></body></html>`;
    const text = extractSiteText(html);
    expect(text).toContain('Title: Resend & Friends');
    expect(text).toContain('Description: Email API for developers');
    expect(text).toContain('Send email reliably');
    expect(text).not.toContain('should not appear');
    expect(text).not.toContain('color: red');
  });

  it('caps the output length', () => {
    const text = extractSiteText(`<body>${'word '.repeat(5000)}</body>`);
    expect(text.length).toBeLessThanOrEqual(8000);
  });
});

describe('extractFaviconUrl', () => {
  it('resolves a relative icon href against the page URL', () => {
    const html = '<link rel="icon" type="image/svg+xml" href="/favicon.svg">';
    expect(extractFaviconUrl(html, 'https://resend.com/')).toBe('https://resend.com/favicon.svg');
  });

  it('matches shortcut icon and absolute hrefs, ignores non-icon links', () => {
    const html =
      '<link rel="stylesheet" href="/app.css"><link rel="shortcut icon" href="https://cdn.x.dev/fav.ico">';
    expect(extractFaviconUrl(html, 'https://x.dev/')).toBe('https://cdn.x.dev/fav.ico');
  });

  it('returns null when no icon link exists', () => {
    expect(extractFaviconUrl('<link rel="stylesheet" href="/a.css">', 'https://x.dev/')).toBeNull();
  });
});

describe('googleFaviconUrl', () => {
  it('builds the s2 fallback from the hostname', () => {
    expect(googleFaviconUrl('https://resend.com/pricing')).toBe(
      'https://www.google.com/s2/favicons?domain=resend.com&sz=64',
    );
  });
});

describe('validateWebsiteUrl', () => {
  it('accepts public http(s) urls', () => {
    expect(validateWebsiteUrl('https://resend.com')?.hostname).toBe('resend.com');
    expect(validateWebsiteUrl('http://example.org/about')?.hostname).toBe('example.org');
  });

  it('rejects non-http schemes and internal targets', () => {
    for (const bad of [
      'ftp://resend.com',
      'file:///etc/passwd',
      'https://localhost:8787',
      'https://foo.localhost',
      'https://db.internal',
      'https://printer.local',
      'https://127.0.0.1',
      'https://10.0.0.5',
      'https://192.168.1.1',
      'https://172.20.0.1',
      'https://169.254.169.254',
      'https://[::1]',
      'not a url',
    ]) {
      expect(validateWebsiteUrl(bad), bad).toBeNull();
    }
  });
});

describe('completeOnboarding', () => {
  it('updates the org and creates keywords, skipping duplicates', async () => {
    const db = createTestD1();
    await seedOrg(db, 'org_1');
    // Pre-existing keyword: onboarding proposing the same term must skip it.
    await createKeyword({ db, orgId: 'org_1', term: 'sendgrid', kind: 'competitor' });

    const result = await completeOnboarding({
      db,
      orgId: 'org_1',
      website: 'https://resend.com',
      brandName: 'Resend',
      logoUrl: 'https://resend.com/favicon.svg',
      context: 'Email API for developers.',
      keywords: [
        { term: 'SendGrid', kind: 'competitor' },
        { term: 'resend', kind: 'brand' },
      ],
    });

    expect(result.keywordsCreated).toBe(1);
    const org = await db
      .prepare('SELECT website, brand_name, description, company_context FROM orgs WHERE id = ?1')
      .bind('org_1')
      .first();
    expect(org).toEqual({
      website: 'https://resend.com',
      brand_name: 'Resend',
      description: 'Email API for developers.',
      company_context: 'Email API for developers.',
    });
    const terms = await db.prepare('SELECT term FROM keywords ORDER BY term').all<{ term: string }>();
    expect(terms.results.map((r) => r.term)).toEqual(['resend', 'sendgrid']);
  });

  it('stops at the plan keyword limit instead of failing the onboarding', async () => {
    const db = createTestD1();
    await seedOrg(db, 'org_1');
    // Free org at capacity (2 active keywords).
    await createKeyword({ db, orgId: 'org_1', term: 'one', kind: 'brand' });
    await createKeyword({ db, orgId: 'org_1', term: 'two', kind: 'brand' });

    const result = await completeOnboarding({
      db,
      orgId: 'org_1',
      website: 'https://x.dev',
      brandName: 'X',
      logoUrl: null,
      context: '',
      keywords: [
        { term: 'three', kind: 'brand' },
        { term: 'four', kind: 'topic' },
      ],
    });
    expect(result.keywordsCreated).toBe(0);
    const count = await db.prepare('SELECT COUNT(*) AS n FROM keywords').first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('propagates non-duplicate insert failures', async () => {
    const db = createTestD1();
    // No org row: the keyword insert hits a real FK failure, which must NOT
    // be swallowed like a duplicate skip.
    await expect(
      completeOnboarding({
        db,
        orgId: 'org_missing',
        website: 'https://x.dev',
        brandName: 'X',
        logoUrl: null,
        context: '',
        keywords: [{ term: 'x term', kind: 'brand' }],
      }),
    ).rejects.toSatisfy((err) => !(err instanceof DuplicateKeywordError));
  });
});
