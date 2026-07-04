import { describe, expect, it } from 'vitest';
import { evalFeedFilter } from './feed-eval';
import type { FeedFilter, Mention } from './schemas';

const baseMention: Mention = {
  id: 'mm_1',
  source: 'hackernews',
  url: 'https://news.ycombinator.com/item?id=1',
  author: 'pg',
  authorUrl: null,
  text: 'Has anyone tried Acme for social listening?',
  publishedAt: 1_700_000_000_000,
  keywordId: 'kw_acme',
  keywordTerm: 'acme',
  state: 'classified',
  relevance: 80,
  sentiment: 'positive',
  intents: ['question', 'buy_intent'],
  aiNote: 'Asking for recommendations, mentions Acme directly',
  createdAt: 1_700_000_000_000,
};

const mention = (overrides: Partial<Mention> = {}): Mention => ({ ...baseMention, ...overrides });

describe('evalFeedFilter', () => {
  it('matches everything with an empty filter', () => {
    expect(evalFeedFilter({}, mention())).toBe(true);
  });

  it('treats empty arrays as no constraint', () => {
    const filter: FeedFilter = { keywordIds: [], sources: [], sentiments: [], intents: [] };
    expect(evalFeedFilter(filter, mention())).toBe(true);
  });

  describe('keywordIds', () => {
    it('passes when the mention keyword is listed', () => {
      expect(evalFeedFilter({ keywordIds: ['kw_other', 'kw_acme'] }, mention())).toBe(true);
    });

    it('fails when the mention keyword is not listed', () => {
      expect(evalFeedFilter({ keywordIds: ['kw_other'] }, mention())).toBe(false);
    });
  });

  describe('sources', () => {
    it('passes on a listed source', () => {
      expect(evalFeedFilter({ sources: ['hackernews', 'github'] }, mention())).toBe(true);
    });

    it('fails on an unlisted source', () => {
      expect(evalFeedFilter({ sources: ['bluesky'] }, mention())).toBe(false);
    });
  });

  describe('minRelevance', () => {
    it('passes when relevance meets the bound (inclusive)', () => {
      expect(evalFeedFilter({ minRelevance: 80 }, mention({ relevance: 80 }))).toBe(true);
    });

    it('fails when relevance is below the bound', () => {
      expect(evalFeedFilter({ minRelevance: 81 }, mention({ relevance: 80 }))).toBe(false);
    });

    it('fails when relevance is null (cannot prove relevance, do not deliver)', () => {
      expect(evalFeedFilter({ minRelevance: 1 }, mention({ relevance: null }))).toBe(false);
    });

    it('minRelevance 0 still requires a non-null relevance', () => {
      expect(evalFeedFilter({ minRelevance: 0 }, mention({ relevance: null }))).toBe(false);
      expect(evalFeedFilter({ minRelevance: 0 }, mention({ relevance: 0 }))).toBe(true);
    });
  });

  describe('sentiments', () => {
    it('passes when the mention sentiment is listed', () => {
      expect(evalFeedFilter({ sentiments: ['positive', 'neutral'] }, mention())).toBe(true);
    });

    it('fails when the mention sentiment is not listed', () => {
      expect(evalFeedFilter({ sentiments: ['negative'] }, mention())).toBe(false);
    });

    it('fails on a null sentiment when a sentiment constraint exists', () => {
      expect(evalFeedFilter({ sentiments: ['positive'] }, mention({ sentiment: null }))).toBe(false);
    });
  });

  describe('intents', () => {
    it('passes when at least one mention intent overlaps the filter (OR semantics)', () => {
      expect(evalFeedFilter({ intents: ['buy_intent', 'complaint'] }, mention())).toBe(true);
    });

    it('fails when no mention intent overlaps the filter', () => {
      expect(evalFeedFilter({ intents: ['complaint'] }, mention())).toBe(false);
    });

    it('fails when the mention has no intents at all', () => {
      expect(evalFeedFilter({ intents: ['question'] }, mention({ intents: [] }))).toBe(false);
    });
  });

  it('ANDs all conditions together', () => {
    const filter: FeedFilter = {
      keywordIds: ['kw_acme'],
      sources: ['hackernews'],
      minRelevance: 50,
      sentiments: ['positive'],
      intents: ['question'],
    };
    expect(evalFeedFilter(filter, mention())).toBe(true);
    // One failing condition sinks the whole filter.
    expect(evalFeedFilter(filter, mention({ sentiment: 'negative' }))).toBe(false);
    expect(evalFeedFilter(filter, mention({ source: 'devto' }))).toBe(false);
    expect(evalFeedFilter(filter, mention({ relevance: 10 }))).toBe(false);
  });
});
