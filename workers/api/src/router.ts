import { OpenAPIHono } from '@hono/zod-openapi';
import type { ZodError } from 'zod';
import { errorBody } from './errors';
import type { AppEnv } from './types';

const summarizeIssues = (error: ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');

/** All routers share one defaultHook so zod failures always produce the
 *  canonical 400 validation_error envelope. */
export function createRouter(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(errorBody('validation_error', summarizeIssues(result.error)), 400);
      }
    },
  });
}
