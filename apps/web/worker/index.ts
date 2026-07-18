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
      return env.API.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
