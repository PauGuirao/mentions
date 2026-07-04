/**
 * MCP tool registry. Every input schema is derived from @mentions/core
 * schemas (omit/extract/reuse), and every handler is a thin skin over the
 * core ops layer; the one exception (get_mention_stats) runs its aggregate
 * here and is flagged as a candidate to move into ops.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  companyContextBodySchema,
  createKeywordBodySchema,
  matchStateSchema,
  searchMentionsQuerySchema,
} from '@mentions/core/schemas';
import { getMention, searchMentions, setMentionState } from '@mentions/core/ops/mentions';
import { createKeyword, listKeywords } from '@mentions/core/ops/keywords';
import { getCompanyContext, setCompanyContext } from '@mentions/core/ops/company';

export interface ToolCtx {
  db: D1Database;
  orgId: string;
}

export type ToolRunResult =
  | { kind: 'ok'; value: unknown }
  | { kind: 'invalid_params'; message: string };

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (ctx: ToolCtx, rawInput: unknown) => Promise<ToolRunResult>;
}

/** zod-to-json-schema returns a wide union of JSON Schema node types; MCP
 *  just needs the plain object, minus the $schema marker. */
function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { $refStrategy: 'none' }) as unknown as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

function tool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  run: (ctx: ToolCtx, input: z.output<S>) => Promise<unknown>;
}): RegisteredTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: toInputSchema(def.schema),
    run: async (ctx, rawInput) => {
      const parsed = def.schema.safeParse(rawInput ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
        return { kind: 'invalid_params', message: `${issue?.message ?? 'invalid input'}${where}` };
      }
      return { kind: 'ok', value: await def.run(ctx, parsed.data) };
    },
  };
}

// Cursor is deliberately not exposed: agents refine filters instead of paging.
const searchMentionsInputSchema = searchMentionsQuerySchema.omit({ cursor: true });

const mentionIdSchema = z.object({
  id: z.string().min(1).describe('Mention id (mention match id, mm_...)'),
});

const setMentionStateInputSchema = mentionIdSchema.extend({
  state: matchStateSchema.extract(['ignored', 'done']),
});

const mentionStatsInputSchema = z.object({
  sinceDays: z.number().int().min(1).max(365).default(7).describe('Look-back window in days'),
});

export const TOOLS: RegisteredTool[] = [
  tool({
    name: 'search_mentions',
    description:
      'Search tracked mentions for your organization. Filter by keyword, source, state, minimum relevance, sentiment, intent, free text and time range. Returns the newest matches first.',
    schema: searchMentionsInputSchema,
    run: async (ctx, input) => {
      const { mentions, nextCursor } = await searchMentions({
        db: ctx.db,
        orgId: ctx.orgId,
        query: input,
      });
      return { mentions, hasMore: nextCursor !== null };
    },
  }),
  tool({
    name: 'get_mention',
    description: 'Fetch a single mention by id, including its classification (relevance, sentiment, intents, note).',
    schema: mentionIdSchema,
    run: async (ctx, input) => {
      const mention = await getMention({ db: ctx.db, orgId: ctx.orgId, mentionMatchId: input.id });
      if (!mention) throw new Error(`Mention not found: ${input.id}`);
      return mention;
    },
  }),
  tool({
    name: 'set_mention_state',
    description:
      'Triage a mention: set its state to "ignored" (not interesting) or "done" (handled). Triaged mentions are excluded from delivery.',
    schema: setMentionStateInputSchema,
    run: async (ctx, input) => {
      await setMentionState({
        db: ctx.db,
        orgId: ctx.orgId,
        mentionMatchId: input.id,
        state: input.state,
      });
      const mention = await getMention({ db: ctx.db, orgId: ctx.orgId, mentionMatchId: input.id });
      return mention ?? { id: input.id, state: input.state };
    },
  }),
  tool({
    name: 'add_keyword',
    description:
      'Start tracking a keyword. kind is "brand" (default), "competitor" or "topic". New mentions containing the term will be matched, classified and delivered.',
    schema: createKeywordBodySchema,
    run: async (ctx, input) => {
      return createKeyword({ db: ctx.db, orgId: ctx.orgId, term: input.term, kind: input.kind });
    },
  }),
  tool({
    name: 'list_keywords',
    description: 'List every tracked keyword for your organization, newest first.',
    schema: z.object({}),
    run: async (ctx) => {
      return listKeywords({ db: ctx.db, orgId: ctx.orgId });
    },
  }),
  tool({
    name: 'get_company_context',
    description:
      'Read the company context the classifier uses to judge relevance (what the company does, products, competitors).',
    schema: z.object({}),
    run: async (ctx) => {
      const context = await getCompanyContext({ db: ctx.db, orgId: ctx.orgId });
      return { context };
    },
  }),
  tool({
    name: 'update_company_context',
    description:
      'Replace the company context fed to the classifier. This is the single biggest lever on relevance scoring, so keep it accurate and specific.',
    schema: companyContextBodySchema,
    run: async (ctx, input) => {
      await setCompanyContext({ db: ctx.db, orgId: ctx.orgId, context: input.context });
      return { ok: true, context: input.context };
    },
  }),
  tool({
    name: 'get_mention_stats',
    description:
      'Mention counts for the last N days (default 7), grouped by source platform and by sentiment. Unclassified mentions appear under sentiment "unclassified".',
    schema: mentionStatsInputSchema,
    run: async (ctx, input) => {
      // Direct D1 aggregate; candidate to move into core ops (ops/mentions)
      // once a second consumer (REST API dashboard) needs the same numbers.
      const since = Date.now() - input.sinceDays * 86_400_000;
      const { results } = await ctx.db
        .prepare(
          `SELECT m.source AS source, mm.sentiment AS sentiment, COUNT(*) AS n
           FROM mention_matches mm
           JOIN mentions m ON m.id = mm.mention_id
           WHERE mm.org_id = ?1 AND mm.created_at >= ?2
           GROUP BY m.source, mm.sentiment`,
        )
        .bind(ctx.orgId, since)
        .all<{ source: string; sentiment: string | null; n: number }>();

      let total = 0;
      const bySource: Record<string, number> = {};
      const bySentiment: Record<string, number> = {};
      for (const row of results) {
        total += row.n;
        bySource[row.source] = (bySource[row.source] ?? 0) + row.n;
        const sentimentKey = row.sentiment ?? 'unclassified';
        bySentiment[sentimentKey] = (bySentiment[sentimentKey] ?? 0) + row.n;
      }
      return { sinceDays: input.sinceDays, total, bySource, bySentiment };
    },
  }),
];
