import { createRoute, z } from '@hono/zod-openapi';
import { revokeSession } from '@mentions/core/ops/sessions';
import {
  DuplicateUserError,
  InvalidCredentialsError,
  getUserWithOrgs,
  login,
  signup,
} from '@mentions/core/ops/users';
import {
  loginBodySchema,
  meResponseSchema,
  sessionResponseSchema,
  signupBodySchema,
} from '@mentions/core/schemas';
import { errorBody, errorResponse } from '../errors';
import { createRouter } from '../router';

const security = [{ bearerAuth: [] }];

const signupRoute = createRoute({
  method: 'post',
  path: '/auth/signup',
  operationId: 'signup',
  tags: ['Auth'],
  request: {
    body: { content: { 'application/json': { schema: signupBodySchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: sessionResponseSchema } },
      description: 'Account and workspace created; the session token is shown exactly once',
    },
    409: errorResponse('An account with this email already exists'),
  },
});

const loginRoute = createRoute({
  method: 'post',
  path: '/auth/login',
  operationId: 'login',
  tags: ['Auth'],
  request: {
    body: { content: { 'application/json': { schema: loginBodySchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: sessionResponseSchema } },
      description: 'Credentials accepted; the session token is shown exactly once',
    },
    401: errorResponse('Invalid email or password'),
  },
});

const logoutRoute = createRoute({
  method: 'post',
  path: '/auth/logout',
  operationId: 'logout',
  tags: ['Auth'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ loggedOut: z.boolean() }) } },
      description: 'Session revoked',
    },
    401: errorResponse('Missing or invalid session token'),
  },
});

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  operationId: 'getMe',
  tags: ['Auth'],
  security,
  responses: {
    200: {
      content: { 'application/json': { schema: meResponseSchema } },
      description: 'The authenticated user and their workspaces',
    },
    401: errorResponse('Session token required (API keys carry no user identity)'),
  },
});

export const authRouter = createRouter();

authRouter.openapi(signupRoute, async (c) => {
  const body = c.req.valid('json');
  try {
    const result = await signup({ db: c.env.DB, ...body });
    return c.json(
      { token: result.session.token, expiresAt: result.session.expiresAt, user: result.user },
      201,
    );
  } catch (err) {
    if (err instanceof DuplicateUserError) {
      return c.json(errorBody('duplicate_user', err.message), 409);
    }
    throw err;
  }
});

authRouter.openapi(loginRoute, async (c) => {
  const body = c.req.valid('json');
  try {
    const result = await login({ db: c.env.DB, ...body });
    return c.json(
      { token: result.session.token, expiresAt: result.session.expiresAt, user: result.user },
      200,
    );
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      return c.json(errorBody('invalid_credentials', err.message), 401);
    }
    throw err;
  }
});

authRouter.openapi(logoutRoute, async (c) => {
  const header = c.req.header('authorization');
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice('bearer '.length).trim() : '';
  const loggedOut = await revokeSession({ db: c.env.DB, kv: c.env.KV, token });
  return c.json({ loggedOut }, 200);
});

authRouter.openapi(meRoute, async (c) => {
  const userId = c.get('userId');
  if (!userId) {
    return c.json(errorBody('unauthorized', 'Session token required'), 401);
  }
  const me = await getUserWithOrgs({ db: c.env.DB, userId });
  if (!me) {
    return c.json(errorBody('unauthorized', 'User no longer exists'), 401);
  }
  return c.json(me, 200);
});
