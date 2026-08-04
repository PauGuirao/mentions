/**
 * Generates one MDX page per API operation from openapi.json into
 * content/docs/api, grouped by tag. The folder is fully regenerated on every
 * build; meta.json is rewritten afterwards to pin the sidebar order.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { generateFiles } from 'fumadocs-openapi';
import { createOpenAPI } from 'fumadocs-openapi/server';

const OUTPUT_DIR = './content/docs/api';

rmSync(OUTPUT_DIR, { recursive: true, force: true });

const kebab = (value) => value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

await generateFiles({
  input: createOpenAPI({ input: ['./openapi.json'] }),
  output: OUTPUT_DIR,
  per: 'operation',
  groupBy: 'tag',
  // kebab-case the camelCase operationIds so URLs read /api/keywords/create-keyword.
  name(output, document) {
    if (output.type === 'operation') {
      const operation = document.paths[output.item.path][output.item.method];
      if (operation.operationId) return kebab(operation.operationId);
      return `${output.item.path.replaceAll('/', '-')}-${output.item.method}`.toLowerCase();
    }
    return 'index';
  },
});

// Folder titles default to title-cased slugs ("Api keys"); pin the right one.
writeFileSync(`${OUTPUT_DIR}/api-keys/meta.json`, `${JSON.stringify({ title: 'API Keys' }, null, 2)}\n`);

// Landing page for /api (the navbar "API Reference" tab target). Written here
// because this whole folder is wiped and regenerated on every build.
writeFileSync(
  `${OUTPUT_DIR}/index.mdx`,
  `---
title: Introduction
description: Every Mentio endpoint, generated from the live OpenAPI spec.
---

The Mentio REST API is served from:

\`\`\`
https://api.mentio.dev/v1
\`\`\`

Authenticate with a Bearer API key minted in the dashboard (or via
[\`POST /v1/api-keys\`](/api/api-keys/create-api-key)):

\`\`\`bash
curl https://api.mentio.dev/v1/keywords \\
  -H "Authorization: Bearer mk_live_..."
\`\`\`

Every page in this section is generated from the same OpenAPI document the
worker serves at \`/v1/openapi.json\`, so the reference can never drift from
the deployed API. Start with [Keywords](/api/keywords/create-keyword) and
[Mentions](/api/mentions/search-mentions), or read
[Authentication](/authentication) for the full auth model.
`,
);

writeFileSync(
  `${OUTPUT_DIR}/meta.json`,
  `${JSON.stringify(
    {
      title: 'API Reference',
      root: true,
      defaultOpen: true,
      pages: ['index', 'keywords', 'mentions', 'company', 'api-keys', 'system', '...'],
    },
    null,
    2,
  )}\n`,
);

console.log(`Generated API reference pages in ${OUTPUT_DIR}`);
