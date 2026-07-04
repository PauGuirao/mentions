/**
 * mentions-mcp: MCP server over streamable HTTP at POST /mcp.
 *
 * IMPLEMENTATION CHOICE (documented per the build brief): this is a minimal,
 * spec-compliant, STATELESS streamable-HTTP JSON-RPC server rather than the
 * 'agents' package's McpAgent. McpAgent's value is durable per-session state
 * via a Durable Object; this server authenticates every request with a
 * Bearer API key, keeps zero session state, and only serves tools/list +
 * tools/call. The streamable HTTP transport spec explicitly allows a server
 * to omit Mcp-Session-Id and answer each POST with a single application/json
 * response, which is exactly what we do. Skipping McpAgent avoids a DO
 * binding, DO migrations and the agents dependency tree for no lost
 * functionality.
 *
 * Supported methods: initialize, ping, tools/list, tools/call. Notifications
 * (no id) are accepted with 202 and ignored. Everything else: -32601.
 */
import { verifyApiKey } from '@mentions/core/ops/api-keys';
import { TOOLS, type ToolCtx } from './tools';

interface Env {
  DB: D1Database;
  KV: KVNamespace;
}

const SERVER_INFO = { name: 'mentions-mcp', version: '0.0.1' };
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = '2025-06-18';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const rpcResult = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Missing or invalid API key' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer realm="mentions-mcp"',
    },
  });
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { jsonrpc?: unknown; method?: unknown; id?: unknown };
  const idOk =
    candidate.id === undefined ||
    candidate.id === null ||
    typeof candidate.id === 'string' ||
    typeof candidate.id === 'number';
  return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string' && idOk;
}

async function callTool(ctx: ToolCtx, params: unknown): Promise<{ ok: unknown } | { invalidParams: string }> {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof p.name !== 'string') return { invalidParams: 'params.name must be a string' };

  const tool = TOOLS.find((t) => t.name === p.name);
  if (!tool) return { invalidParams: `Unknown tool: ${p.name}` };

  const run = await tool.run(ctx, p.arguments);
  if (run.kind === 'invalid_params') return { invalidParams: run.message };
  return {
    ok: {
      content: [{ type: 'text', text: JSON.stringify(run.value, null, 2) }],
      isError: false,
    },
  };
}

/** Handle one JSON-RPC message. Returns null for notifications (no id). */
async function handleMessage(message: unknown, ctx: ToolCtx): Promise<JsonRpcResponse | null> {
  if (!isJsonRpcRequest(message)) {
    return rpcError(null, INVALID_REQUEST, 'Not a valid JSON-RPC 2.0 request');
  }
  const isNotification = message.id === undefined;
  const id: JsonRpcId = message.id ?? null;

  if (message.method.startsWith('notifications/')) return null;

  switch (message.method) {
    case 'initialize': {
      const params = (message.params ?? {}) as { protocolVersion?: unknown };
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'Social listening tools for your organization: search and triage mentions, manage tracked keywords, tune the classifier via company context, and pull mention stats.',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case 'tools/call': {
      try {
        const outcome = await callTool(ctx, message.params);
        if ('invalidParams' in outcome) return rpcError(id, INVALID_PARAMS, outcome.invalidParams);
        return rpcResult(id, outcome.ok);
      } catch (err) {
        // Tool execution failures are results with isError, not protocol errors.
        const text = err instanceof Error ? err.message : String(err);
        return rpcResult(id, { content: [{ type: 'text', text: `Error: ${text}` }], isError: true });
      }
    }
    default:
      return isNotification ? null : rpcError(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') {
      return json({ error: 'Not found. MCP endpoint is POST /mcp' }, 404);
    }
    if (request.method !== 'POST') {
      // Stateless server: no server-initiated SSE stream (GET) and no
      // session to delete (DELETE).
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }

    const authHeader = request.headers.get('authorization') ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
    if (token === '') return unauthorized();

    const auth = await verifyApiKey({ db: env.DB, kv: env.KV, token });
    if (!auth) return unauthorized();
    const ctx: ToolCtx = { db: env.DB, orgId: auth.orgId };

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(rpcError(null, PARSE_ERROR, 'Body is not valid JSON'));
    }

    // Single message is the 2025-06-18 shape; arrays are tolerated for
    // older clients that still batch.
    if (Array.isArray(body)) {
      if (body.length === 0) return json(rpcError(null, INVALID_REQUEST, 'Empty batch'));
      const responses: JsonRpcResponse[] = [];
      for (const message of body) {
        const response = await handleMessage(message, ctx);
        if (response) responses.push(response);
      }
      return responses.length > 0 ? json(responses) : new Response(null, { status: 202 });
    }

    const response = await handleMessage(body, ctx);
    return response ? json(response) : new Response(null, { status: 202 });
  },
} satisfies ExportedHandler<Env>;
