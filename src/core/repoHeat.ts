import { runGit, sinceArgs, GitOptions } from './git';
import { makeMatcher } from './glob';
import { makeScale } from './scale';

export type Metric = 'commits' | 'churn' | 'authors';

export interface HeatStats {
  commits: number;
  added: number;
  deleted: number;
  authors: Map<string, number>;
  lastTs: number;
  /** 0..1 according to the selected metric */
  heat: number;
}

export interface RepoHeat {
  root: string;
  since: string;
  metric: Metric;
  totalCommits: number;
  /** every file tracked at HEAD (including files never touched during the period) */
  tracked: string[];
  /** key = path relative to the repo, '/' separator */
  files: Map<string, HeatStats>;
  /** key = relative folder path ('' = root) */
  dirs: Map<string, HeatStats>;
  computedAt: number;
}

export interface RepoHeatOptions extends GitOptions {
  since: string;
  metric: Metric;
  exclude: string[];
  excludeAuthors: string;
}

const RS = '\x1e';
const US = '\x1f';

function emptyStats(): HeatStats {
  return { commits: 0, added: 0, deleted: 0, authors: new Map(), lastTs: 0, heat: 0 };
}

export function metricValue(s: HeatStats, metric: Metric): number {
  switch (metric) {
    case 'churn':
      return s.added + s.deleted;
    case 'authors':
      return s.authors.size;
    default:
      return s.commits;
  }
}

/** "a/b/c.ts" -> ['', 'a', 'a/b'] */
function parentDirs(path: string): string[] {
  const dirs = [''];
  let idx = path.indexOf('/');
  while (idx !== -1) {
    dirs.push(path.slice(0, idx));
    idx = path.indexOf('/', idx + 1);
  }
  return dirs;
}

export async function computeRepoHeat(opts: RepoHeatOptions): Promise<RepoHeat> {
  const [log, lsFiles] = await Promise.all([
    runGit(
      ['log', '--no-merges', '-M', '--numstat', '-z', `--format=${RS}%H${US}%at${US}%aN${US}%aE`, ...sinceArgs(opts.since), 'HEAD'],
      opts,
    ),
    runGit(['ls-files', '-z'], opts),
  ]);

  const tracked = new Set(lsFiles.split('\0').filter(Boolean));
  const isExcluded = makeMatcher(opts.exclude);
  let authorFilter: RegExp | undefined;
  try {
    authorFilter = opts.excludeAuthors.trim() ? new RegExp(opts.excludeAuthors, 'i') : undefined;
  } catch {
    authorFilter = undefined;
  }

  // The log goes from newest to oldest: when a rename old -> new shows up,
  // every older commit on "old" must be attributed to the current name.
  const renamedTo = new Map<string, string>();
  const resolve = (p: string): string => {
    let cur = p;
    for (let guard = 0; guard < 50; guard++) {
      const next = renamedTo.get(cur);
      if (next === undefined || next === cur) {
        break;
      }
      cur = next;
    }
    return cur;
  };

  const files = new Map<string, HeatStats>();
  const dirs = new Map<string, HeatStats>();
  let totalCommits = 0;

  for (const chunk of log.split(RS)) {
    if (!chunk) {
      continue;
    }
    const headerEnd = chunk.indexOf('\0');
    const header = headerEnd === -1 ? chunk : chunk.slice(0, headerEnd);
    const [, tsStr, name, email] = header.split(US);
    const ts = Number(tsStr) * 1000;
    const authorKey = (name || email || '?').trim();
    const skipAuthor = authorFilter ? authorFilter.test(`${name} <${email}>`) : false;

    const tokens = headerEnd === -1 ? [] : chunk.slice(headerEnd + 1).split('\0');
    const touchedDirs = new Map<string, { added: number; deleted: number }>();

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i].replace(/^\n+/, '');
      if (!tok) {
        continue;
      }
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tok);
      if (!m) {
        continue;
      }
      const added = m[1] === '-' ? 0 : Number(m[1]);
      const deleted = m[2] === '-' ? 0 : Number(m[2]);
      let path: string;
      if (m[3] === '') {
        // rename: the next 2 tokens are the old and new paths
        const oldPath = tokens[++i];
        const newPath = tokens[++i];
        path = resolve(newPath);
        if (oldPath !== path) {
          renamedTo.set(oldPath, path);
        }
      } else {
        path = resolve(m[3]);
      }

      if (skipAuthor || !tracked.has(path) || isExcluded(path)) {
        continue;
      }

      let fs = files.get(path);
      if (!fs) {
        fs = emptyStats();
        files.set(path, fs);
      }
      fs.commits++;
      fs.added += added;
      fs.deleted += deleted;
      fs.authors.set(authorKey, (fs.authors.get(authorKey) ?? 0) + 1);
      fs.lastTs = Math.max(fs.lastTs, ts);

      for (const d of parentDirs(path)) {
        const acc = touchedDirs.get(d) ?? { added: 0, deleted: 0 };
        acc.added += added;
        acc.deleted += deleted;
        touchedDirs.set(d, acc);
      }
    }

    if (touchedDirs.size > 0) {
      totalCommits++;
    }
    for (const [d, acc] of touchedDirs) {
      let ds = dirs.get(d);
      if (!ds) {
        ds = emptyStats();
        dirs.set(d, ds);
      }
      ds.commits++;
      ds.added += acc.added;
      ds.deleted += acc.deleted;
      ds.authors.set(authorKey, (ds.authors.get(authorKey) ?? 0) + 1);
      ds.lastTs = Math.max(ds.lastTs, ts);
    }
  }

  applyMetric({ files, dirs }, opts.metric);

  return {
    root: opts.cwd,
    since: opts.since,
    metric: opts.metric,
    totalCommits,
    tracked: [...tracked].filter((p) => !isExcluded(p)),
    files,
    dirs,
    computedAt: Date.now(),
  };
}

/** (Re)computes the heat field of every entry, so the metric can change without running git again. */
export function applyMetric(heat: Pick<RepoHeat, 'files' | 'dirs'> & { metric?: Metric }, metric: Metric): void {
  const fileScale = makeScale([...heat.files.values()].map((s) => metricValue(s, metric)));
  for (const s of heat.files.values()) {
    s.heat = fileScale(metricValue(s, metric));
  }
  // The root is left out of the scale, otherwise it flattens everything.
  const dirEntries = [...heat.dirs.entries()].filter(([d]) => d !== '');
  const dirScale = makeScale(dirEntries.map(([, s]) => metricValue(s, metric)), 0.9);
  for (const [d, s] of heat.dirs) {
    s.heat = d === '' ? 1 : dirScale(metricValue(s, metric));
  }
  heat.metric = metric;
}

// --- serialization (disk cache) ---

type SerializedStats = [string, number, number, number, [string, number][], number];

export interface SerializedRepoHeat {
  root: string;
  since: string;
  totalCommits: number;
  tracked: string[];
  files: SerializedStats[];
  dirs: SerializedStats[];
  computedAt: number;
}

function ser(m: Map<string, HeatStats>): SerializedStats[] {
  return [...m.entries()].map(([k, s]) => [k, s.commits, s.added, s.deleted, [...s.authors.entries()], s.lastTs]);
}

function deser(a: SerializedStats[]): Map<string, HeatStats> {
  return new Map(a.map(([k, commits, added, deleted, authors, lastTs]) => [k, { commits, added, deleted, authors: new Map(authors), lastTs, heat: 0 }]));
}

export function serializeRepoHeat(h: RepoHeat): SerializedRepoHeat {
  return { root: h.root, since: h.since, totalCommits: h.totalCommits, tracked: h.tracked, files: ser(h.files), dirs: ser(h.dirs), computedAt: h.computedAt };
}

export function deserializeRepoHeat(s: SerializedRepoHeat, metric: Metric): RepoHeat {
  const h: RepoHeat = { ...s, metric, files: deser(s.files), dirs: deser(s.dirs) };
  applyMetric(h, metric);
  return h;
}
