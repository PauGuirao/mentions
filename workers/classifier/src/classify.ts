/**
 * Pure classification helpers: prompt construction and LLM response parsing.
 * No network, no bindings; everything here is unit-tested in classify.test.ts.
 * The queue consumer (index.ts) owns the actual AI/D1/queue side effects.
 */
import { classificationSchema, type Classification } from '@mentions/core/schemas';

/** The one place the model id lives. */
export const CLASSIFIER_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** Matches at/above go to delivery; below are kept as state 'filtered'. */
export const RELEVANCE_THRESHOLD = 40;

/** Mention text is stored up to 8KB; cap what we burn on prompt tokens. */
const MAX_MENTION_CHARS = 6000;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const ALLOWED_INTENTS = classificationSchema.shape.intents.element.options;
const ALLOWED_SENTIMENTS = classificationSchema.shape.sentiment.options;

const SYSTEM_PROMPT = [
  'You are the relevance classifier of a social listening tool.',
  'You are given a company description, a tracked keyword, and a social media mention that contains the keyword.',
  'Decide how relevant the mention is to that specific company and classify it.',
  '',
  'Respond with ONLY a single JSON object, no markdown fences, no prose, exactly this shape:',
  `{"relevance": <integer 0-100>, "sentiment": ${ALLOWED_SENTIMENTS.map((s) => `"${s}"`).join(' | ')}, "intents": <array, subset of [${ALLOWED_INTENTS.map((i) => `"${i}"`).join(', ')}]>, "note": "<one short sentence, max 200 chars>"}`,
  '',
  'Relevance rubric:',
  '- 90-100: the mention is about this company or its product directly.',
  '- 60-89: discusses the company\'s space or a need its product clearly serves.',
  '- 40-59: tangentially related; the company is plausibly but not clearly concerned.',
  '- 0-39: unrelated or a coincidental keyword hit (same word, different thing).',
  '',
  'Sentiment is the author\'s tone toward the matched subject, not general mood.',
  'Include an intent only when the text clearly supports it; an empty array is fine.',
  'The note must be a single plain-text line explaining your relevance call.',
].join('\n');

export function buildClassifyMessages(args: {
  companyContext: string;
  keywordTerm: string;
  mentionText: string;
  source: string;
}): ChatMessage[] {
  const { companyContext, keywordTerm, mentionText, source } = args;
  const truncated =
    mentionText.length > MAX_MENTION_CHARS
      ? `${mentionText.slice(0, MAX_MENTION_CHARS)}\n[truncated]`
      : mentionText;

  const user = [
    'Company context:',
    companyContext.trim() === '' ? '(none provided)' : companyContext.trim(),
    '',
    `Tracked keyword: "${keywordTerm}"`,
    `Source platform: ${source}`,
    '',
    'Mention text:',
    '"""',
    truncated,
    '"""',
    '',
    'Classify this mention. Reply with the JSON object only.',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Second-chance conversation after an unparseable first reply. */
export function buildJsonRetryMessages(args: {
  messages: ChatMessage[];
  badReply: string;
}): ChatMessage[] {
  const nudge: ChatMessage = {
    role: 'user',
    content:
      'Your previous reply was not a valid JSON object. Return ONLY the JSON object described in the instructions. No markdown, no code fences, no explanations.',
  };
  if (args.badReply.trim() === '') {
    return [...args.messages, nudge];
  }
  return [...args.messages, { role: 'assistant', content: args.badReply }, nudge];
}

/**
 * Extract the assistant text out of whatever shape env.AI.run returned.
 * Text-generation models return either the legacy { response?: string } or an
 * OpenAI-compatible chat.completion envelope with the text at
 * choices[0].message.content; anything else (streams, tool calls, unexpected
 * shapes) yields null.
 */
export function extractResponseText(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (output === null || typeof output !== 'object') return null;

  if ('response' in output) {
    const response = (output as { response?: unknown }).response;
    if (typeof response === 'string') return response;
  }

  if ('choices' in output) {
    const choices = (output as { choices?: unknown }).choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first: unknown = choices[0];
      if (first !== null && typeof first === 'object' && 'message' in first) {
        const message = (first as { message?: unknown }).message;
        if (message !== null && typeof message === 'object' && 'content' in message) {
          const content = (message as { content?: unknown }).content;
          if (typeof content === 'string') return content;
        }
      }
    }
  }

  return null;
}

/**
 * Parse an LLM reply into a Classification, or null when unusable.
 *
 * Deliberately forgiving about packaging (code fences, prose around the JSON)
 * and about small numeric sloppiness (float or out-of-range relevance is
 * rounded and clamped; unknown intents are dropped; note is truncated), but
 * strict about substance: missing/invalid relevance or sentiment fails the
 * parse so the caller can retry with a nudge.
 */
export function parseClassificationResponse(raw: string): Classification | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...obj };

  if (typeof obj['relevance'] === 'number' && Number.isFinite(obj['relevance'])) {
    normalized['relevance'] = Math.min(100, Math.max(0, Math.round(obj['relevance'])));
  }
  if (typeof obj['sentiment'] === 'string') {
    normalized['sentiment'] = obj['sentiment'].toLowerCase().trim();
  }
  if (Array.isArray(obj['intents'])) {
    normalized['intents'] = obj['intents'].filter(
      (i): i is string => typeof i === 'string' && (ALLOWED_INTENTS as readonly string[]).includes(i),
    );
  }
  if (typeof obj['note'] === 'string') {
    normalized['note'] = obj['note'].slice(0, 200);
  } else if (obj['note'] === null || obj['note'] === undefined) {
    normalized['note'] = '';
  }

  const result = classificationSchema.safeParse(normalized);
  return result.success ? result.data : null;
}
