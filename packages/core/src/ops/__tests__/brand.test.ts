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
import { createDbStub } from './stubs';

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
    const { db, queries } = createDbStub((query) => {
      if (query.sql.startsWith('INSERT INTO keywords') && query.params[2] === 'sendgrid') {
        return { error: new Error('UNIQUE constraint failed: keywords.org_id, keywords.normalized_term') };
      }
      return {};
    });

    const result = await completeOnboarding({
      db,
      orgId: 'org_1',
      website: 'https://resend.com',
      brandName: 'Resend',
      logoUrl: 'https://resend.com/favicon.svg',
      context: 'Email API for developers.',
      keywords: [
        { term: 'resend', kind: 'brand' },
        { term: 'email api', kind: 'topic' },
        { term: 'sendgrid', kind: 'competitor' },
      ],
    });

    expect(result.keywordsCreated).toBe(2);
    const update = queries[0];
    expect(update?.sql).toContain('UPDATE orgs SET website');
    expect(update?.params.slice(0, 5)).toEqual([
      'https://resend.com',
      'Resend',
      'https://resend.com/favicon.svg',
      'Email API for developers.',
      'Email API for developers.',
    ]);
    expect(update?.params[6]).toBe('org_1');
    expect(queries.filter((q) => q.sql.startsWith('INSERT INTO keywords'))).toHaveLength(3);
  });

  it('stops at the plan keyword limit instead of failing the onboarding', async () => {
    // Free org at capacity: the guarded insert matches no row (changes 0).
    const { db, queries } = createDbStub((query) =>
      query.sql.startsWith('INSERT INTO keywords') ? { changes: 0 } : {},
    );
    const result = await completeOnboarding({
      db,
      orgId: 'org_1',
      website: 'https://x.dev',
      brandName: 'X',
      logoUrl: null,
      context: '',
      keywords: [
        { term: 'one', kind: 'brand' },
        { term: 'two', kind: 'topic' },
      ],
    });
    expect(result.keywordsCreated).toBe(0);
    // The loop breaks on the first limit hit; keyword two is never attempted.
    expect(queries.filter((q) => q.sql.startsWith('INSERT INTO keywords'))).toHaveLength(1);
  });

  it('propagates non-duplicate insert failures', async () => {
    const { db } = createDbStub((query) =>
      query.sql.startsWith('INSERT INTO keywords') ? { error: new Error('disk full') } : {},
    );
    await expect(
      completeOnboarding({
        db,
        orgId: 'org_1',
        website: 'https://x.dev',
        brandName: 'X',
        logoUrl: null,
        context: '',
        keywords: [{ term: 'x term', kind: 'brand' }],
      }),
    ).rejects.toThrow('disk full');
  });
});
