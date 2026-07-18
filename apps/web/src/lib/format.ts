import type { Source } from '@mentions/core/schemas';

export const SOURCE_LABELS: Record<Source, string> = {
  bluesky: 'Bluesky',
  hackernews: 'Hacker News',
  github: 'GitHub',
  stackoverflow: 'Stack Overflow',
  devto: 'DEV',
  reddit: 'Reddit',
  x: 'X',
  youtube: 'YouTube',
  news: 'News',
};

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function relativeTime(epochMs: number): string {
  const diff = epochMs - Date.now();
  const abs = Math.abs(diff);
  if (abs < MINUTE) return 'just now';
  if (abs < HOUR) return rtf.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), 'hour');
  if (abs < 30 * DAY) return rtf.format(Math.round(diff / DAY), 'day');
  return new Date(epochMs).toLocaleDateString();
}

export function fullDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
