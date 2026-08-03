import { useQuery } from '@tanstack/react-query';
import { api, hasCredentials } from './api';
import { isLoggedIn } from './auth-client';

export function useKeywords() {
  return useQuery({
    queryKey: ['keywords'],
    queryFn: api.listKeywords,
    enabled: hasCredentials(),
  });
}

/** Session users only: /v1/me 401s for API-key callers (no user identity). */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    enabled: isLoggedIn(),
    staleTime: 5 * 60_000,
  });
}
