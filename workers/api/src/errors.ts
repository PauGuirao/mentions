import { z } from '@hono/zod-openapi';

/** Canonical error envelope: { error: { code, message } } with stable codes. */
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
    }),
  })
  .openapi('ErrorResponse');

export type ErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'validation_error'
  | 'duplicate_keyword'
  | 'invalid_cursor'
  | 'internal_error';

export const errorBody = (code: ErrorCode, message: string) => ({ error: { code, message } });

/** Response entry for createRoute() error statuses. */
export const errorResponse = (description: string) => ({
  content: { 'application/json': { schema: errorResponseSchema } },
  description,
});
