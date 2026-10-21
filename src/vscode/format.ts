import * as vscode from 'vscode';
import { HeatStats, Metric, metricValue } from '../core/repoHeat';

// Dates follow the VS Code display language; fall back to English if the runtime lacks it.
function locale(): string {
  try {
    return Intl.RelativeTimeFormat.supportedLocalesOf([vscode.env.language]).length ? vscode.env.language : 'en';
  } catch {
    return 'en';
  }
}

const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });

export function ago(ts: number): string {
  if (!ts) {
    return 'never';
  }
  const s = (ts - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 3600) {
    return rtf.format(Math.round(s / 60), 'minute');
  }
  if (abs < 86400) {
    return rtf.format(Math.round(s / 3600), 'hour');
  }
  if (abs < 86400 * 30) {
    return rtf.format(Math.round(s / 86400), 'day');
  }
  if (abs < 86400 * 365) {
    return rtf.format(Math.round(s / (86400 * 30)), 'month');
  }
  return rtf.format(Math.round(s / (86400 * 365)), 'year');
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: 'numeric' });
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export const METRIC_LABELS: Record<Metric, string> = {
  commits: 'Commits',
  churn: 'Changed lines (churn)',
  authors: 'Distinct authors',
};

export function metricShort(s: HeatStats, metric: Metric): string {
  const v = metricValue(s, metric);
  switch (metric) {
    case 'churn':
      return plural(v, 'line');
    case 'authors':
      return plural(v, 'author');
    default:
      return plural(v, 'commit');
  }
}

export function statsSummary(s: HeatStats): string {
  return `${plural(s.commits, 'commit')} · ${plural(s.authors.size, 'author')} · +${s.added}/−${s.deleted}`;
}

export function topAuthors(authors: Map<string, number>, n = 3): string {
  return [...authors.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, c]) => `${name} (${c})`)
    .join(', ');
}

export function badge(v: number): string {
  // Explorer badges are limited to 2 characters
  return v > 99 ? '99' : String(v);
}
