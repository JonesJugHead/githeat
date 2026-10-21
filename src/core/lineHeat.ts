import { runGit, sinceArgs, GitOptions } from './git';

export interface CommitInfo {
  hash: string;
  ts: number;
  author: string;
  email: string;
  subject: string;
  /** file path in this commit (follows renames) */
  path: string;
  excluded: boolean;
}

export interface LineInfo {
  /** indexes into LineHeat.commits of the commits that changed this line (newest to oldest) */
  touches: number[];
  /** changed locally, not committed yet */
  uncommitted: boolean;
}

export interface LineHeat {
  path: string;
  commits: CommitInfo[];
  lines: LineInfo[];
  maxTouches: number;
}

export interface BlockStats {
  commits: number[];
  authors: Map<string, number>;
  lastTs: number;
  touchedLines: number;
  uncommittedLines: number;
}

export interface LineHeatOptions extends GitOptions {
  /** path relative to the repo, '/' separator */
  path: string;
  /** line count of the working copy */
  lineCount: number;
  since: string;
  excludeAuthors: string;
  maxCommits?: number;
}

interface Hunk {
  a: number;
  b: number;
  c: number;
  d: number;
}

const RS = '\x1e';
const US = '\x1f';
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunks(diff: string): { hunks: Hunk[]; newPath?: string } {
  const hunks: Hunk[] = [];
  let newPath: string | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m) {
        hunks.push({
          a: Number(m[1]),
          b: m[2] === undefined ? 1 : Number(m[2]),
          c: Number(m[3]),
          d: m[4] === undefined ? 1 : Number(m[4]),
        });
      }
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p.startsWith('b/')) {
        newPath = p.slice(2);
      }
    }
  }
  return { hunks, newPath };
}

/**
 * Walks a diff backwards ("new" -> "old" version): updates the position of every tracked
 * line and calls onTouch for lines inside a changed hunk.
 * pos[i] = 1-based position of line i in the current version, 0 = line no longer tracked
 * (it did not exist before this commit).
 */
function stepBack(pos: Int32Array, hunks: Hunk[], onTouch: (line: number) => void): number {
  let alive = 0;
  let j = 0;
  let delta = 0;
  // Pure deletion: no remaining line is in the hunk, so the change counts for its neighbours.
  const nearDeletion = new Set<number>();
  for (const h of hunks) {
    if (h.d === 0) {
      nearDeletion.add(h.c);
      nearDeletion.add(h.c + 1);
    }
  }
  for (let i = 0; i < pos.length; i++) {
    const p = pos[i];
    if (p === 0) {
      continue;
    }
    // Positions stay increasing: a single pass is enough.
    while (j < hunks.length) {
      const h = hunks[j];
      const newEnd = h.d === 0 ? h.c : h.c + h.d - 1;
      if (newEnd >= p) {
        break;
      }
      delta += h.d - h.b;
      j++;
    }
    const h = hunks[j];
    if (h && h.d > 0 && p >= h.c && p <= h.c + h.d - 1) {
      onTouch(i);
      const k = p - h.c;
      // Changed line: keep tracking it on the matching line of the old version.
      pos[i] = k < h.b ? h.a + k : 0;
    } else {
      if (nearDeletion.has(p)) {
        onTouch(i);
      }
      pos[i] = p - delta;
    }
    if (pos[i] > 0) {
      alive++;
    }
  }
  return alive;
}

export async function computeLineHeat(opts: LineHeatOptions): Promise<LineHeat> {
  const lines: LineInfo[] = Array.from({ length: opts.lineCount }, () => ({ touches: [], uncommitted: false }));
  const pos = new Int32Array(opts.lineCount);
  for (let i = 0; i < pos.length; i++) {
    pos[i] = i + 1;
  }

  let authorFilter: RegExp | undefined;
  try {
    authorFilter = opts.excludeAuthors.trim() ? new RegExp(opts.excludeAuthors, 'i') : undefined;
  } catch {
    authorFilter = undefined;
  }

  const [workDiff, log] = await Promise.all([
    runGit(['diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff', '--', opts.path], opts).catch(() => ''),
    runGit(
      [
        'log', '--follow', '-M', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-merges',
        `--format=${RS}%H${US}%at${US}%aN${US}%aE${US}%s${US}`,
        `-n${opts.maxCommits ?? 1000}`,
        ...sinceArgs(opts.since),
        'HEAD', '--', opts.path,
      ],
      opts,
    ).catch(() => ''),
  ]);

  // 1) uncommitted local changes: map lines back to the HEAD version
  let alive = stepBack(pos, parseHunks(workDiff).hunks, (i) => {
    lines[i].uncommitted = true;
  });

  // 2) history, newest to oldest
  const commits: CommitInfo[] = [];
  let currentPath = opts.path;
  for (const chunk of log.split(RS)) {
    if (!chunk || alive === 0) {
      continue;
    }
    const parts = chunk.split(US);
    const [hash, tsStr, author, email, subject] = parts;
    const body = parts.slice(5).join(US);
    const { hunks, newPath } = parseHunks(body);
    if (newPath) {
      currentPath = newPath;
    }
    const excluded = authorFilter ? authorFilter.test(`${author} <${email}>`) : false;
    const idx = commits.length;
    commits.push({ hash, ts: Number(tsStr) * 1000, author, email, subject, path: currentPath, excluded });
    alive = stepBack(pos, hunks, (i) => {
      if (!excluded) {
        lines[i].touches.push(idx);
      }
    });
  }

  let maxTouches = 0;
  for (const l of lines) {
    maxTouches = Math.max(maxTouches, l.touches.length);
  }
  return { path: opts.path, commits, lines, maxTouches };
}

/** Aggregates lines [start, end] (0-based, inclusive) of a code block. */
export function blockStats(heat: LineHeat, start: number, end: number): BlockStats {
  const seen = new Set<number>();
  let touchedLines = 0;
  let uncommittedLines = 0;
  for (let i = Math.max(0, start); i <= Math.min(end, heat.lines.length - 1); i++) {
    const l = heat.lines[i];
    if (l.touches.length > 0) {
      touchedLines++;
    }
    if (l.uncommitted) {
      uncommittedLines++;
    }
    for (const c of l.touches) {
      seen.add(c);
    }
  }
  const commits = [...seen].sort((x, y) => x - y);
  const authors = new Map<string, number>();
  let lastTs = 0;
  for (const c of commits) {
    const info = heat.commits[c];
    authors.set(info.author, (authors.get(info.author) ?? 0) + 1);
    lastTs = Math.max(lastTs, info.ts);
  }
  return { commits, authors, lastTs, touchedLines, uncommittedLines };
}
