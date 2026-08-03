/**
 * Onboarding: analyze the user's website into a brand profile + starter
 * keyword suggestions, then persist the confirmed profile. All product logic
 * lives in @mentions/core/ops/brand; this file only owns the outbound fetch
 * and the Workers AI call.
 */
import { createRoute } from '@hono/zod-openapi';
import {
  BRAND_MODEL,
  buildBrandAnalysisMessages,
  buildBrandJsonRetryMessages,
  completeOnboarding,
  extractAiText,
  extractFaviconUrl,
  extractSiteText,
  googleFaviconUrl,
  parseBrandAnalysisResponse,
  validateWebsiteUrl,
  type ChatMessage,
} from '@mentions/core/ops/brand';
import {
  onboardingAnalyzeBodySchema,
  onboardingAnalyzeResponseSchema,
  onboardingCompleteBodySchema,
  onboardingCompleteResponseSchema,
  type BrandAnalysis,
} from '@mentions/core/schemas';
import { ADAPTER_HEADERS } from '@mentions/core/sources/util';
import { errorBody, errorResponse } from '../errors';
import { createRouter } from '../router';
import type { Env } from '../types';

const security = [{ bearerAuth: [] }];

/** A homepage bigger than this is cut before text extraction. */
const MAX_HTML_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const analyzeRoute = createRoute({
  method: 'post',
  path: '/onboarding/analyze',
  operationId: 'analyzeWebsite',
  tags: ['Onboarding'],
  security,
  request: {
    body: {
      content: { 'application/json': { schema: onboardingAnalyzeBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: onboardingAnalyzeResponseSchema } },
      description: 'Suggested brand profile and starter keywords (nothing is persisted yet)',
    },
    400: errorResponse('URL invalid, not publicly reachable, or no readable content'),
    401: errorResponse('Missing or invalid credentials'),
    500: errorResponse('Analysis failed'),
  },
});

const completeRoute = createRoute({
  method: 'post',
  path: '/onboarding/complete',
  operationId: 'completeOnboarding',
  tags: ['Onboarding'],
  security,
  request: {
    body: {
      content: { 'application/json': { schema: onboardingCompleteBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: onboardingCompleteResponseSchema } },
      description: 'Brand profile saved and starter keywords created',
    },
    401: errorResponse('Missing or invalid credentials'),
  },
});

async function runBrandModel(env: Env, messages: ChatMessage[]): Promise<string | null> {
  try {
    const output = await env.AI.run(BRAND_MODEL, { messages, max_tokens: 800 });
    return extractAiText(output);
  } catch (err) {
    console.error('[onboarding] AI.run failed', err instanceof Error ? err.message : err);
    return null;
  }
}

/** One attempt plus one JSON-nudge retry, like the classifier. */
async function analyzeWithRetry(env: Env, messages: ChatMessage[]): Promise<BrandAnalysis | null> {
  const first = await runBrandModel(env, messages);
  if (first) {
    const parsed = parseBrandAnalysisResponse(first);
    if (parsed) return parsed;
  }
  const second = await runBrandModel(
    env,
    buildBrandJsonRetryMessages({ messages, badReply: first ?? '' }),
  );
  return second ? parseBrandAnalysisResponse(second) : null;
}

export const onboardingRouter = createRouter();

onboardingRouter.openapi(analyzeRoute, async (c) => {
  const { website } = c.req.valid('json');

  const url = validateWebsiteUrl(website);
  if (!url) {
    return c.json(errorBody('validation_error', 'Enter a public http(s) website URL'), 400);
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { ...ADAPTER_HEADERS, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return c.json(errorBody('validation_error', 'Could not reach that website'), 400);
  }
  if (!res.ok) {
    return c.json(
      errorBody('validation_error', `The website responded with HTTP ${res.status}`),
      400,
    );
  }

  const html = (await res.text()).slice(0, MAX_HTML_BYTES);
  const pageText = extractSiteText(html);
  if (pageText === '') {
    return c.json(errorBody('validation_error', 'The website returned no readable content'), 400);
  }

  const analysis = await analyzeWithRetry(
    c.env,
    buildBrandAnalysisMessages({ website: url.toString(), pageText }),
  );
  if (!analysis) {
    return c.json(
      errorBody('internal_error', 'Could not analyze the website, please try again'),
      500,
    );
  }

  // res.url is the post-redirect page; relative favicon hrefs resolve there.
  const logoUrl = extractFaviconUrl(html, res.url || url.toString()) ?? googleFaviconUrl(url.toString());
  return c.json({ ...analysis, website: url.toString(), logoUrl }, 200);
});

onboardingRouter.openapi(completeRoute, async (c) => {
  const body = c.req.valid('json');
  const { keywordsCreated } = await completeOnboarding({
    db: c.env.DB,
    orgId: c.get('orgId'),
    website: body.website,
    brandName: body.brandName,
    logoUrl: body.logoUrl ?? null,
    context: body.context,
    keywords: body.keywords,
  });
  return c.json({ ok: true as const, keywordsCreated }, 200);
});
