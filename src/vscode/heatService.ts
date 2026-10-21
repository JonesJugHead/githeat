import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { computeLineHeat, LineHeat } from '../core/lineHeat';
import {
  applyMetric,
  computeRepoHeat,
  deserializeRepoHeat,
  HeatStats,
  Metric,
  RepoHeat,
  serializeRepoHeat,
  SerializedRepoHeat,
} from '../core/repoHeat';
import { GitAPI, GitRepository } from './gitApi';

export interface Settings {
  since: string;
  metric: Metric;
  exclude: string[];
  excludeAuthors: string;
  explorerEnabled: boolean;
  linesEnabled: boolean;
  linesBackground: boolean;
  codeLensEnabled: boolean;
  linesMaxCommits: number;
  hotspotsLimit: number;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('githeat');
  return {
    since: c.get('since', '6 months ago'),
    metric: c.get<Metric>('metric', 'commits'),
    exclude: c.get<string[]>('exclude', []),
    excludeAuthors: c.get('excludeAuthors', ''),
    explorerEnabled: c.get('explorer.enabled', true),
    linesEnabled: c.get('lines.enabled', true),
    linesBackground: c.get('lines.background', false),
    codeLensEnabled: c.get('codeLens.enabled', true),
    linesMaxCommits: Math.max(10, c.get('lines.maxCommits', 1000)),
    hotspotsLimit: Math.max(1, c.get('hotspots.limit', 50)),
  };
}

interface RepoState {
  repo: GitRepository;
  root: string;
  head?: string;
  heat?: RepoHeat;
  computing?: Promise<void>;
  abort?: AbortController;
  /** rank per file (0 = hottest), for the "top x%" label */
  rank?: Map<string, number>;
}

interface CachedLineHeat {
  key: string;
  heat: Promise<LineHeat>;
}

const isWin = process.platform === 'win32';
const norm = (p: string) => (isWin ? p.toLowerCase() : p);

/** Single source of data: detects repositories, computes and caches the heatmaps. */
export class HeatService implements vscode.Disposable {
  private readonly repos = new Map<string, RepoState>();
  private readonly lineCache = new Map<string, CachedLineHeat>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly headTimers = new Map<string, NodeJS.Timeout>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** fired when a repo heatmap changes (computation done, metric changed...) */
  readonly onDidChange = this._onDidChange.event;
  settings = readSettings();

  constructor(
    private readonly git: GitAPI,
    private readonly storage: vscode.Uri,
  ) {
    for (const r of git.repositories) {
      this.addRepo(r);
    }
    this.disposables.push(
      git.onDidOpenRepository((r) => this.addRepo(r)),
      git.onDidCloseRepository((r) => {
        this.repos.get(norm(r.rootUri.fsPath))?.abort?.abort();
        this.repos.delete(norm(r.rootUri.fsPath));
        this._onDidChange.fire();
      }),
      this._onDidChange,
    );
  }

  dispose(): void {
    for (const s of this.repos.values()) {
      s.abort?.abort();
    }
    for (const t of this.headTimers.values()) {
      clearTimeout(t);
    }
    this.disposables.forEach((d) => d.dispose());
  }

  get repoStates(): RepoState[] {
    return [...this.repos.values()].sort((a, b) => a.root.localeCompare(b.root));
  }

  get isComputing(): boolean {
    return [...this.repos.values()].some((s) => s.computing);
  }

  private addRepo(repo: GitRepository): void {
    const root = repo.rootUri.fsPath;
    if (this.repos.has(norm(root))) {
      return;
    }
    const state: RepoState = { repo, root, head: repo.state.HEAD?.commit };
    this.repos.set(norm(root), state);
    this.disposables.push(
      repo.state.onDidChange(() => {
        const head = repo.state.HEAD?.commit;
        if (head && head !== state.head) {
          // debounce: a rebase / pull fires many events
          clearTimeout(this.headTimers.get(root));
          this.headTimers.set(
            root,
            setTimeout(() => {
              state.head = repo.state.HEAD?.commit;
              this.invalidateLines(root);
              void this.computeRepo(state, false);
            }, 1500),
          );
        }
      }),
    );
    void this.computeRepo(state, false);
  }

  /** Recomputes everything (force = ignore the disk cache). */
  async refreshAll(force: boolean): Promise<void> {
    this.settings = readSettings();
    this.lineCache.clear();
    await Promise.all([...this.repos.values()].map((s) => this.computeRepo(s, force)));
  }

  /** Metric change: no need to run git again. */
  applyMetric(): void {
    this.settings = readSettings();
    for (const s of this.repos.values()) {
      if (s.heat) {
        applyMetric(s.heat, this.settings.metric);
        this.updateRank(s);
      }
    }
    this._onDidChange.fire();
  }

  private cacheKey(state: RepoState): string {
    const { since, exclude, excludeAuthors } = this.settings;
    return JSON.stringify({ v: 2, head: state.head, since, exclude, excludeAuthors });
  }

  private cacheFile(state: RepoState): vscode.Uri {
    const h = crypto.createHash('sha1').update(norm(state.root)).digest('hex').slice(0, 16);
    return vscode.Uri.joinPath(this.storage, `repo-${h}.json`);
  }

  private computeRepo(state: RepoState, force: boolean): Promise<void> {
    state.abort?.abort();
    const abort = new AbortController();
    state.abort = abort;
    state.head = state.repo.state.HEAD?.commit ?? state.head;
    const key = this.cacheKey(state);

    const run = async () => {
      if (!force) {
        const cached = await this.readCache(state, key);
        if (cached) {
          state.heat = cached;
          this.updateRank(state);
          this._onDidChange.fire();
          return;
        }
      }
      this._onDidChange.fire(); // to show "analysis in progress"
      const heat = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `GitHeat: analyzing ${path.basename(state.root)}…` },
        () =>
          computeRepoHeat({
            cwd: state.root,
            gitPath: this.git.git.path,
            signal: abort.signal,
            since: this.settings.since,
            metric: this.settings.metric,
            exclude: this.settings.exclude,
            excludeAuthors: this.settings.excludeAuthors,
          }),
      );
      state.heat = heat;
      this.updateRank(state);
      void this.writeCache(state, key, heat);
    };

    const p = run()
      .catch((e: Error) => {
        if (!abort.signal.aborted) {
          void vscode.window.showWarningMessage(`GitHeat: ${e.message}`);
        }
      })
      .finally(() => {
        if (state.abort === abort) {
          state.computing = undefined;
          this._onDidChange.fire();
        }
      });
    state.computing = p;
    return p;
  }

  private async readCache(state: RepoState, key: string): Promise<RepoHeat | undefined> {
    try {
      const raw = await vscode.workspace.fs.readFile(this.cacheFile(state));
      const data = JSON.parse(Buffer.from(raw).toString('utf8')) as { key: string; heat: SerializedRepoHeat };
      return data.key === key ? deserializeRepoHeat({ ...data.heat, root: state.root }, this.settings.metric) : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeCache(state: RepoState, key: string, heat: RepoHeat): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.storage);
      const data = JSON.stringify({ key, heat: serializeRepoHeat(heat) });
      await vscode.workspace.fs.writeFile(this.cacheFile(state), Buffer.from(data, 'utf8'));
    } catch {
      // best-effort cache
    }
  }

  private updateRank(state: RepoState): void {
    if (!state.heat) {
      return;
    }
    const sorted = [...state.heat.files.entries()].sort((a, b) => b[1].heat - a[1].heat || b[1].commits - a[1].commits);
    state.rank = new Map(sorted.map(([p], i) => [p, i]));
  }

  // --- URI -> repo resolution ---

  repoFor(uri: vscode.Uri): RepoState | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const p = norm(uri.fsPath);
    let best: RepoState | undefined;
    for (const [root, s] of this.repos) {
      if ((p === root || p.startsWith(root + path.sep)) && (!best || root.length > norm(best.root).length)) {
        best = s;
      }
    }
    return best;
  }

  relPath(state: RepoState, uri: vscode.Uri): string {
    return path.relative(state.root, uri.fsPath).split(path.sep).join('/');
  }

  /** Stats of a file or folder (undefined if never touched during the period). */
  statsFor(uri: vscode.Uri): { state: RepoState; rel: string; stats?: HeatStats; isDir: boolean } | undefined {
    const state = this.repoFor(uri);
    if (!state?.heat) {
      return undefined;
    }
    const rel = this.relPath(state, uri);
    const file = state.heat.files.get(rel);
    if (file) {
      return { state, rel, stats: file, isDir: false };
    }
    const dir = state.heat.dirs.get(rel);
    return { state, rel, stats: dir, isDir: dir !== undefined };
  }

  /** Position of the file in the repo ranking: 0.02 = top 2%. */
  rankOf(state: RepoState, rel: string): number | undefined {
    const r = state.rank?.get(rel);
    return r === undefined || !state.heat ? undefined : (r + 1) / Math.max(1, state.heat.tracked.length);
  }

  // --- line-by-line heat ---

  lineHeatFor(doc: vscode.TextDocument): Promise<LineHeat> | undefined {
    const state = this.repoFor(doc.uri);
    if (!state || doc.isDirty || doc.isUntitled) {
      return undefined;
    }
    const rel = this.relPath(state, doc.uri);
    const key = `${state.head}|${doc.version}|${this.settings.since}|${this.settings.excludeAuthors}|${this.settings.linesMaxCommits}`;
    const cached = this.lineCache.get(doc.uri.toString());
    if (cached?.key === key) {
      return cached.heat;
    }
    const heat = computeLineHeat({
      cwd: state.root,
      gitPath: this.git.git.path,
      path: rel,
      lineCount: doc.lineCount,
      since: this.settings.since,
      excludeAuthors: this.settings.excludeAuthors,
      maxCommits: this.settings.linesMaxCommits,
    });
    this.lineCache.set(doc.uri.toString(), { key, heat });
    heat.catch(() => this.lineCache.delete(doc.uri.toString()));
    return heat;
  }

  private invalidateLines(root: string): void {
    for (const k of [...this.lineCache.keys()]) {
      const uri = vscode.Uri.parse(k);
      if (norm(uri.fsPath).startsWith(norm(root))) {
        this.lineCache.delete(k);
      }
    }
  }

  gitPath(): string {
    return this.git.git.path;
  }
}
