/**
 * Feed filter evaluation. A FeedFilter is a conjunction (AND) of optional
 * conditions; within a single array condition membership is a disjunction (OR).
 *
 * Semantics, in full:
 *   - A condition that is absent imposes no constraint.
 *   - An EMPTY array also imposes no constraint (defensive: UIs and API
 *     clients routinely send `[]` to mean "everything"; treating it as
 *     "match nothing" would silently dead-end a feed).
 *   - keywordIds / sources / sentiments: the mention's value must be one of
 *     the listed values.
 *   - intents: at least one of the mention's intents must appear in the
 *     filter's list (set intersection, not subset).
 *   - minRelevance: mention.relevance must be non-null and >= the bound.
 *     A null relevance (not yet classified, or classification_failed) FAILS
 *     any minRelevance constraint: we cannot prove relevance, so we do not
 *     deliver. Same rule for a null sentiment against a sentiments constraint.
 *
 * Pure function: no I/O, fully unit-tested in feed-eval.test.ts.
 */
import type { FeedFilter, Mention } from './schemas';

export function evalFeedFilter(filter: FeedFilter, mention: Mention): boolean {
  const { keywordIds, sources, minRelevance, sentiments, intents } = filter;

  if (keywordIds && keywordIds.length > 0 && !keywordIds.includes(mention.keywordId)) {
    return false;
  }

  if (sources && sources.length > 0 && !sources.includes(mention.source)) {
    return false;
  }

  if (minRelevance !== undefined) {
    if (mention.relevance === null || mention.relevance < minRelevance) {
      return false;
    }
  }

  if (sentiments && sentiments.length > 0) {
    if (mention.sentiment === null || !sentiments.includes(mention.sentiment)) {
      return false;
    }
  }

  if (intents && intents.length > 0) {
    if (!mention.intents.some((i) => intents.includes(i))) {
      return false;
    }
  }

  return true;
}
