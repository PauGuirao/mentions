/**
 * Better Auth client. Same-origin: the Vite dev server proxies /v1 to the API
 * worker and the deployed worker forwards it over a service binding, so the
 * session cookie just works with no CORS.
 *
 * LOGGED_IN_MARKER exists because the cookie is httpOnly (invisible to JS):
 * the router guard needs a synchronous signal that a session should exist.
 * The API client clears it when a request comes back 401.
 */
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({ baseURL: '/v1/auth' });

const LOGGED_IN_MARKER = 'mentions.loggedIn';

export function markLoggedIn(): void {
  localStorage.setItem(LOGGED_IN_MARKER, '1');
}

export function clearLoggedIn(): void {
  localStorage.removeItem(LOGGED_IN_MARKER);
}

export function isLoggedIn(): boolean {
  return localStorage.getItem(LOGGED_IN_MARKER) === '1';
}
