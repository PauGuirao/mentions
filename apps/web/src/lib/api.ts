/**
 * Thin typed client for the Mentions REST API. All shapes come from
 * @mentions/core/schemas so the app never re-declares a type the API owns.
 * The base URL defaults to same-origin: the Vite dev server proxies /v1 to the
 * API worker, and the deployed worker forwards /v1/* over a service binding.
 */
import type { Keyword, Mention, SearchMentionsQuery } from '@mentions/core/schemas';

const API_KEY_STORAGE = 'mentions.apiKey';
const API_URL_STORAGE = 'mentions.apiUrl';

export function getApiKey(): string {
  return localStorage.getItem(API_KEY_STORAGE) ?? '';
}

export function setApiKey(key: string): void {
  if (key) localStorage.setItem(API_KEY_STORAGE, key);
  else localStorage.removeItem(API_KEY_STORAGE);
}

export function hasApiKey(): boolean {
  return getApiKey() !== '';
}

export function getApiUrl(): string {
  return localStorage.getItem(API_URL_STORAGE) ?? '';
}

export function setApiUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed) localStorage.setItem(API_URL_STORAGE, trimmed);
  else localStorage.removeItem(API_URL_STORAGE);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiUrl()}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let code = 'internal_error';
    let message = `Request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body; keep the fallback message.
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export type MentionFilters = Partial<Omit<SearchMentionsQuery, 'limit'>>;
export interface MentionsPage {
  mentions: Mention[];
  nextCursor: string | null;
}

export const api = {
  searchMentions(filters: MentionFilters): Promise<MentionsPage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return request(`/mentions${qs ? `?${qs}` : ''}`);
  },

  setMentionState(id: string, state: 'ignored' | 'done'): Promise<{ id: string; state: string }> {
    return request(`/mentions/${id}/state`, { method: 'POST', body: JSON.stringify({ state }) });
  },

  listKeywords(): Promise<{ keywords: Keyword[] }> {
    return request('/keywords');
  },

  createKeyword(body: { term: string; kind: Keyword['kind'] }): Promise<Keyword> {
    return request('/keywords', { method: 'POST', body: JSON.stringify(body) });
  },

  deleteKeyword(keywordId: string): Promise<{ deleted: boolean }> {
    return request(`/keywords/${keywordId}`, { method: 'DELETE' });
  },

  setKeywordMuted(keywordId: string, muted: boolean): Promise<{ id: string; muted: boolean }> {
    return request(`/keywords/${keywordId}`, { method: 'PATCH', body: JSON.stringify({ muted }) });
  },

  getCompanyContext(): Promise<{ context: string }> {
    return request('/company');
  },

  setCompanyContext(context: string): Promise<{ context: string }> {
    return request('/company', { method: 'PUT', body: JSON.stringify({ context }) });
  },
};
