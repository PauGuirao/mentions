import { useQuery } from '@tanstack/react-query';
import { api, hasApiKey } from './api';

export function useKeywords() {
  return useQuery({
    queryKey: ['keywords'],
    queryFn: api.listKeywords,
    enabled: hasApiKey(),
  });
}
