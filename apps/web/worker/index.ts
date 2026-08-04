/**
 * Serves the built SPA and forwards /v1/* to the mentions-api worker over a
 * service binding so the dashboard stays same-origin (no CORS). No product
 * logic here (invariant); this is transport only.
 */
interface Env {
  API: Fetcher;
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
      // Buffer the body before crossing the service binding: streaming it
      // through stalls intermittently (observed as infinite sign-in and
      // hanging dashboard POSTs). /v1 bodies are small JSON, so buffering
      // costs nothing.
      if (request.body === null) {
        return env.API.fetch(request);
      }
      const body = await request.arrayBuffer();
      return env.API.fetch(new Request(request, { body }));
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
