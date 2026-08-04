/**
 * Exports the OpenAPI document straight from the API worker's route
 * definitions (zod schemas in core are the source of truth), so the docs can
 * never drift from the deployed API. Run with tsx; the worker module only
 * touches Cloudflare bindings at request time, so importing it in Node is
 * safe.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import app from '../../../workers/api/src/index';

const doc = app.getOpenAPIDocument({
  openapi: '3.0.0',
  info: {
    title: 'Mentions API',
    version: '0.0.1',
    description: 'Keyword and brand mention tracking across dev platforms.',
  },
  // Without servers, the docs playground and code samples fall back to the
  // docs site's own origin.
  servers: [{ url: 'https://api.mentio.dev' }],
});

// The generator's groupBy: 'tag' only keeps operations whose tags are also
// declared at the document root, which @hono/zod-openapi does not emit.
// Derive them in first-appearance order.
const tagNames: string[] = [];
for (const pathItem of Object.values(doc.paths ?? {})) {
  for (const operation of Object.values(pathItem as Record<string, unknown>)) {
    const tags = (operation as { tags?: string[] }).tags ?? [];
    for (const tag of tags) {
      if (!tagNames.includes(tag)) tagNames.push(tag);
    }
  }
}
doc.tags = tagNames.map((name) => ({ name }));

const out = fileURLToPath(new URL('../openapi.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`Wrote ${out} (${Object.keys(doc.paths ?? {}).length} paths)`);
