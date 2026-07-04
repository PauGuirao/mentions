import { describe, expect, it } from 'vitest';
import {
  buildClassifyMessages,
  buildJsonRetryMessages,
  extractResponseText,
  parseClassificationResponse,
} from './classify';

describe('buildClassifyMessages', () => {
  const args = {
    companyContext: 'Acme sells developer-first social listening APIs. Competitor: Octolens.',
    keywordTerm: 'acme',
    mentionText: 'Just tried Acme for brand monitoring, pretty impressed.',
    source: 'hackernews',
  };

  it('produces a system + user message pair', () => {
    const messages = buildClassifyMessages(args);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });

  it('embeds context, keyword, source and mention text in the user message', () => {
    const user = buildClassifyMessages(args)[1]?.content ?? '';
    expect(user).toContain(args.companyContext);
    expect(user).toContain('"acme"');
    expect(user).toContain('hackernews');
    expect(user).toContain(args.mentionText);
  });

  it('demands JSON-only output in the system prompt', () => {
    const system = buildClassifyMessages(args)[0]?.content ?? '';
    expect(system).toContain('ONLY a single JSON object');
    expect(system).toContain('"relevance"');
    expect(system).toContain('buy_intent');
  });

  it('marks a missing company context instead of leaving a blank', () => {
    const user = buildClassifyMessages({ ...args, companyContext: '  ' })[1]?.content ?? '';
    expect(user).toContain('(none provided)');
  });

  it('truncates very long mention text', () => {
    const long = 'x'.repeat(10_000);
    const user = buildClassifyMessages({ ...args, mentionText: long })[1]?.content ?? '';
    expect(user).toContain('[truncated]');
    expect(user.length).toBeLessThan(8_000);
  });
});

describe('buildJsonRetryMessages', () => {
  const original = buildClassifyMessages({
    companyContext: 'ctx',
    keywordTerm: 'kw',
    mentionText: 'text',
    source: 'devto',
  });

  it('appends the bad reply and a JSON-only nudge', () => {
    const retry = buildJsonRetryMessages({ messages: original, badReply: 'Sure! Here you go: {oops' });
    expect(retry).toHaveLength(original.length + 2);
    expect(retry[retry.length - 2]?.role).toBe('assistant');
    expect(retry[retry.length - 2]?.content).toContain('{oops');
    expect(retry[retry.length - 1]?.role).toBe('user');
    expect(retry[retry.length - 1]?.content).toContain('ONLY the JSON object');
  });

  it('skips the assistant echo when the bad reply was empty', () => {
    const retry = buildJsonRetryMessages({ messages: original, badReply: '   ' });
    expect(retry).toHaveLength(original.length + 1);
    expect(retry[retry.length - 1]?.role).toBe('user');
  });

  it('does not mutate the original messages array', () => {
    const before = original.length;
    buildJsonRetryMessages({ messages: original, badReply: 'bad' });
    expect(original).toHaveLength(before);
  });
});

describe('extractResponseText', () => {
  it('reads { response } objects', () => {
    expect(extractResponseText({ response: 'hello' })).toBe('hello');
  });

  it('passes plain strings through', () => {
    expect(extractResponseText('hi')).toBe('hi');
  });

  it('returns null for streams, nulls and odd shapes', () => {
    expect(extractResponseText(null)).toBeNull();
    expect(extractResponseText(undefined)).toBeNull();
    expect(extractResponseText({ response: 42 })).toBeNull();
    expect(extractResponseText({ tool_calls: [] })).toBeNull();
  });
});

describe('parseClassificationResponse', () => {
  const valid = {
    relevance: 85,
    sentiment: 'positive',
    intents: ['praise'],
    note: 'Direct praise of the product.',
  };

  it('parses a clean JSON object', () => {
    expect(parseClassificationResponse(JSON.stringify(valid))).toEqual(valid);
  });

  it('parses JSON wrapped in markdown fences', () => {
    const raw = '```json\n' + JSON.stringify(valid) + '\n```';
    expect(parseClassificationResponse(raw)).toEqual(valid);
  });

  it('parses JSON surrounded by prose', () => {
    const raw = 'Here is the classification you asked for:\n' + JSON.stringify(valid) + '\nHope that helps!';
    expect(parseClassificationResponse(raw)).toEqual(valid);
  });

  it('rounds float relevance to an integer', () => {
    const parsed = parseClassificationResponse(JSON.stringify({ ...valid, relevance: 87.6 }));
    expect(parsed?.relevance).toBe(88);
  });

  it('clamps out-of-range relevance instead of failing', () => {
    expect(parseClassificationResponse(JSON.stringify({ ...valid, relevance: 150 }))?.relevance).toBe(100);
    expect(parseClassificationResponse(JSON.stringify({ ...valid, relevance: -5 }))?.relevance).toBe(0);
  });

  it('drops unknown intents but keeps known ones', () => {
    const parsed = parseClassificationResponse(
      JSON.stringify({ ...valid, intents: ['praise', 'meme', 'buy_intent'] }),
    );
    expect(parsed?.intents).toEqual(['praise', 'buy_intent']);
  });

  it('normalizes sentiment casing', () => {
    const parsed = parseClassificationResponse(JSON.stringify({ ...valid, sentiment: ' Positive ' }));
    expect(parsed?.sentiment).toBe('positive');
  });

  it('truncates an overlong note', () => {
    const parsed = parseClassificationResponse(JSON.stringify({ ...valid, note: 'n'.repeat(500) }));
    expect(parsed?.note).toHaveLength(200);
  });

  it('defaults a missing note to an empty string', () => {
    const { note: _note, ...withoutNote } = valid;
    expect(parseClassificationResponse(JSON.stringify(withoutNote))?.note).toBe('');
  });

  it('rejects an invalid sentiment', () => {
    expect(parseClassificationResponse(JSON.stringify({ ...valid, sentiment: 'mixed' }))).toBeNull();
  });

  it('rejects a missing relevance', () => {
    const { relevance: _r, ...withoutRelevance } = valid;
    expect(parseClassificationResponse(JSON.stringify(withoutRelevance))).toBeNull();
  });

  it('rejects non-array intents', () => {
    expect(parseClassificationResponse(JSON.stringify({ ...valid, intents: 'praise' }))).toBeNull();
  });

  it('rejects garbage, arrays and non-JSON', () => {
    expect(parseClassificationResponse('total garbage')).toBeNull();
    expect(parseClassificationResponse('{"relevance": 50')).toBeNull();
    expect(parseClassificationResponse('[1,2,3]')).toBeNull();
    expect(parseClassificationResponse("{'relevance': 50}")).toBeNull();
  });
});
