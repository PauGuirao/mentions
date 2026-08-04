import { createOpenAPI } from 'fumadocs-openapi/server';
import spec from '../openapi.json';

/** The spec is exported from the API worker's route definitions at build
 *  time (scripts/export-openapi.ts), so reference pages can never drift.
 *
 *  The function-input form maps the key the generated MDX pages reference
 *  ("./openapi.json" in their <APIPage document=...>) to the BUNDLED parsed
 *  document. A plain path input would be read from the filesystem at request
 *  time, which 500s on Cloudflare Workers (no fs in production). */
export const openapi = createOpenAPI({
  input: async () => ({ './openapi.json': spec }),
});
