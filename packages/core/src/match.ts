/**
 * Multi-keyword text matcher. MVP implementation: word-boundary regex per
 * unique normalized term over lowercased text. At current scale (hundreds of
 * terms, thousands of items/min) this is comfortably fast in a Worker; swap
 * for Aho-Corasick behind the same interface if the term registry grows into
 * the tens of thousands.
 *
 * Matching rules (deliberately simple and predictable for users):
 *   - case-insensitive
 *   - word-boundary on both ends ("late" must not match "translate")
 *   - multi-word terms match as a phrase with flexible whitespace
 */

export interface TermEntry<T> {
  normalizedTerm: string;
  /** Opaque payload fanned back on match (e.g. subscriber keyword rows). */
  payload: T;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildMatcher<T>(entries: ReadonlyArray<TermEntry<T>>): (text: string) => T[] {
  // One compiled regex per unique term; grouped map term -> payloads so the
  // same term tracked by many orgs costs one regex test.
  const byTerm = new Map<string, { re: RegExp; payloads: T[] }>();
  for (const entry of entries) {
    const term = entry.normalizedTerm;
    const existing = byTerm.get(term);
    if (existing) {
      existing.payloads.push(entry.payload);
      continue;
    }
    const pattern = escapeRegex(term).replace(/\s+/g, '\\s+');
    byTerm.set(term, {
      re: new RegExp(`(?:^|[^\\p{L}\\p{N}_])${pattern}(?=$|[^\\p{L}\\p{N}_])`, 'iu'),
      payloads: [entry.payload],
    });
  }

  return (text: string): T[] => {
    const hits: T[] = [];
    for (const { re, payloads } of byTerm.values()) {
      if (re.test(text)) hits.push(...payloads);
    }
    return hits;
  };
}

/** Canonical term normalization — MUST match what keywords.normalized_term
 *  stores (ops/keywords.ts) and what per-term fetch jobs use as identity. */
export function normalizeTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, ' ');
}
