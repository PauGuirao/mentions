import { describe, expect, it } from 'vitest';
import type { RawItem } from '../../schemas';
import { clampText, decodeEntities, finalizeItems, MAX_TEXT_CHARS, stripHtml } from '../util';

describe('stripHtml', () => {
  it('removes tags, decodes entities, and collapses whitespace', () => {
    expect(stripHtml('<p>a &amp; b<&#x2F;p>  <p>c&#39;s &quot;d&quot;</p>')).toBe(
      'a & b c\'s "d"',
    );
  });

  it('does not throw on out-of-range numeric entities', () => {
    expect(stripHtml('bad &#x110000; entity')).toBe('bad entity');
  });
});

describe('decodeEntities', () => {
  it('decodes hex, decimal, and named entities without touching angle brackets', () => {
    expect(decodeEntities('Vec&lt;String&gt; &#233; &#x27;ok&#x27;')).toBe("Vec<String> é 'ok'");
  });
});

describe('clampText', () => {
  it('truncates to the 8KB ingest cap', () => {
    expect(clampText('x'.repeat(MAX_TEXT_CHARS + 100))).toHaveLength(MAX_TEXT_CHARS);
    expect(clampText('short')).toBe('short');
  });
});

describe('finalizeItems', () => {
  const valid = (overrides: Partial<RawItem>): RawItem => ({
    source: 'hackernews',
    externalId: 'id1',
    url: 'https://news.ycombinator.com/item?id=1',
    text: 'hello',
    publishedAt: 1_000,
    ...overrides,
  });

  it('drops nulls and schema-invalid items, sorts survivors oldest-first', () => {
    const items = finalizeItems({
      source: 'hackernews',
      candidates: [
        valid({ externalId: 'b', publishedAt: 2_000 }),
        null,
        valid({ externalId: 'bad-url', url: 'not-a-url' }),
        valid({ externalId: 'a', publishedAt: 1_000 }),
      ],
    });
    expect(items.map((i) => i.externalId)).toEqual(['a', 'b']);
  });
});
