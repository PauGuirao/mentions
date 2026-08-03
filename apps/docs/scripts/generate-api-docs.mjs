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

writeFileSync(
  `${OUTPUT_DIR}/meta.json`,
  `${JSON.stringify(
    {
      title: 'API Reference',
      defaultOpen: true,
      pages: ['keywords', 'mentions', 'company', 'api-keys', 'system', '...'],
    },
    null,
    2,
  )}\n`,
);

console.log(`Generated API reference pages in ${OUTPUT_DIR}`);
