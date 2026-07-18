import { useQuery } from '@tanstack/react-query';
import { api, hasCredentials } from './api';

export function useKeywords() {
  return useQuery({
    queryKey: ['keywords'],
    queryFn: api.listKeywords,
    enabled: hasCredentials(),
  });
}
