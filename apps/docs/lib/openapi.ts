import { createOpenAPI } from 'fumadocs-openapi/server';

/** The spec is exported from the API worker's route definitions at build
 *  time (scripts/export-openapi.ts), so reference pages can never drift. */
export const openapi = createOpenAPI({
  input: ['./openapi.json'],
});
