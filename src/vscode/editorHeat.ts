import * as path from 'path';
import * as vscode from 'vscode';
import { runGit } from '../core/git';
import { blockStats, CommitInfo, LineHeat } from '../core/lineHeat';
import { TIERS } from '../core/scale';
import { ago, formatDate, plural, topAuthors } from './format';
import { HeatService } from './heatService';

const HEX = ['#4FA3E0', '#C9C94A', '#F0A030', '#F06A3A', '#FF3B5C'];

/** Tier 1..5 of a line, relative to the file max (floor of 4 so that a rarely changed file stays cold). */
function lineTier(touches: number, max: number): number {
  if (touches === 0) {
    return 0;
  }
  const h = Math.log1p(touches) / Math.log1p(Math.max(max, 4));
  return Math.max(1, Math.min(TIERS, Math.ceil(h * TIERS)));
}

export function commitDiffLink(root: string, c: CommitInfo): string {
  return `command:githeat.openCommitDiff?${encodeURIComponent(JSON.stringify([root, c.hash, c.path, c.subject]))}`;
}

/** Colored gutter + line-by-line hover. */
export class EditorHeatController implements vscode.Disposable {
  private gutter: vscode.TextEditorDecorationType[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly service: HeatService,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.createTypes();
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
      service.onDidChange(() => this.schedule()),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover: (d, p) => this.provideHover(d, p) }),
    );
    this.schedule();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.gutter.forEach((t) => t.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  /** Call again when display settings change. */
  recreate(): void {
    this.gutter.forEach((t) => t.dispose());
    this.createTypes();
    this.schedule();
  }

  private createTypes(): void {
    const bg = this.service.settings.linesBackground;
    this.gutter = HEX.map((hex, i) =>
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', `gutter-${i + 1}.svg`),
        gutterIconSize: 'contain',
        overviewRulerColor: new vscode.ThemeColor(`githeat.heat${i + 1}`),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        isWholeLine: true,
        backgroundColor: bg ? `${hex}${['10', '16', '1E', '28', '33'][i]}` : undefined,
      }),
    );
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      for (const e of vscode.window.visibleTextEditors) {
        void this.update(e);
      }
    }, 150);
  }

  private clear(editor: vscode.TextEditor): void {
    this.gutter.forEach((t) => editor.setDecorations(t, []));
  }

  private async update(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    if (!this.service.settings.linesEnabled) {
      this.clear(editor);
      return;
    }
    const pending = this.service.lineHeatFor(doc);
    if (!pending) {
      // unsaved document: existing decorations follow the edits
      return;
    }
    let heat: LineHeat;
    try {
      heat = await pending;
    } catch {
      this.clear(editor);
      return;
    }
    if (doc.isClosed || doc.isDirty) {
      return;
    }
    const ranges: vscode.Range[][] = HEX.map(() => []);
    heat.lines.forEach((l, i) => {
      const t = lineTier(l.touches.length, heat.maxTouches);
      if (t > 0 && i < doc.lineCount) {
        ranges[t - 1].push(new vscode.Range(i, 0, i, 0));
      }
    });
    this.gutter.forEach((t, i) => editor.setDecorations(t, ranges[i]));
  }

  private async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    if (!this.service.settings.linesEnabled) {
      return undefined;
    }
    const state = this.service.repoFor(doc.uri);
    const pending = this.service.lineHeatFor(doc);
    if (!state || !pending) {
      return undefined;
    }
    const heat = await pending.catch(() => undefined);
    const line = heat?.lines[pos.line];
    if (!heat || !line) {
      return undefined;
    }
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['githeat.openCommitDiff'] };
    const authors = new Map<string, number>();
    for (const c of line.touches) {
      const a = heat.commits[c].author;
      authors.set(a, (authors.get(a) ?? 0) + 1);
    }
    md.appendMarkdown(`**$(flame) GitHeat** — line changed in **${plural(line.touches.length, 'commit')}**`);
    if (authors.size) {
      md.appendMarkdown(` by ${topAuthors(authors)}`);
    }
    if (line.uncommitted) {
      md.appendMarkdown('\n\n$(circle-filled) Changed locally (not committed)');
    }
    md.appendMarkdown('\n\n');
    for (const c of line.touches.slice(0, 8)) {
      const info = heat.commits[c];
      md.appendMarkdown(
        `- [\`${info.hash.slice(0, 7)}\`](${commitDiffLink(state.root, info)}) ${escapeMd(info.subject)} — *${escapeMd(info.author)}, ${ago(info.ts)}*\n`,
      );
    }
    if (line.touches.length > 8) {
      md.appendMarkdown(`- … and ${line.touches.length - 8} more\n`);
    }
    return new vscode.Hover(md, doc.lineAt(pos.line).range);
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

// --- code blocks (functions / classes / methods) ---

const BLOCK_KINDS = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Module,
  vscode.SymbolKind.Namespace,
]);
// `const Foo = () => {...}` (React components...) is reported as Variable/Constant
const MAYBE_BLOCK_KINDS = new Set([vscode.SymbolKind.Variable, vscode.SymbolKind.Constant, vscode.SymbolKind.Property, vscode.SymbolKind.Object]);
const MIN_LINES = 3;
const MAX_DEPTH = 3;

interface Block {
  name: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
  selection: vscode.Range;
}

function flattenSymbols(symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): Block[] {
  const out: Block[] = [];
  const walk = (list: vscode.DocumentSymbol[], depth: number) => {
    for (const s of list) {
      const lines = s.range.end.line - s.range.start.line + 1;
      const isBlock = BLOCK_KINDS.has(s.kind) || (MAYBE_BLOCK_KINDS.has(s.kind) && lines >= 5);
      if (isBlock && lines >= MIN_LINES) {
        out.push({ name: s.name, kind: s.kind, range: s.range, selection: s.selectionRange });
      }
      if (depth < MAX_DEPTH && s.children?.length) {
        walk(s.children, depth + 1);
      }
    }
  };
  if (symbols.length && 'children' in symbols[0]) {
    walk(symbols as vscode.DocumentSymbol[], 1);
  } else {
    for (const s of symbols as vscode.SymbolInformation[]) {
      const r = s.location.range;
      if (BLOCK_KINDS.has(s.kind) && r.end.line - r.start.line + 1 >= MIN_LINES) {
        out.push({ name: s.name, kind: s.kind, range: r, selection: r });
      }
    }
  }
  return out;
}

export interface BlockCommitsArgs {
  uri: string;
  start: number;
  end: number;
  name: string;
}

/** CodeLens above each block: commits, authors, recency, share of the file commits. */
export class BlockCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly retries = new Map<string, number>();

  constructor(private readonly service: HeatService) {
    this.disposables.push(
      service.onDidChange(() => this._onDidChange.fire()),
      vscode.workspace.onDidSaveTextDocument(() => this._onDidChange.fire()),
      this._onDidChange,
    );
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!this.service.settings.codeLensEnabled) {
      return [];
    }
    const pending = this.service.lineHeatFor(doc);
    if (!pending) {
      return [];
    }
    const [heat, symbols] = await Promise.all([
      pending.catch(() => undefined),
      vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri,
      ),
    ]);
    if (!heat) {
      return [];
    }
    if (!symbols?.length) {
      // the language server is often not ready when the file opens: ask again a bit later
      const key = `${doc.uri.toString()}|${doc.version}`;
      const n = this.retries.get(key) ?? 0;
      if (n < 3 && doc.lineCount > 10) {
        this.retries.set(key, n + 1);
        setTimeout(() => this._onDidChange.fire(), 2000 * (n + 1));
      }
      return [];
    }

    const fileCommits = heat.commits.filter((c) => !c.excluded).length;
    const seenLines = new Set<number>();
    const lenses: vscode.CodeLens[] = [];
    for (const b of flattenSymbols(symbols)) {
      const start = b.range.start.line;
      const end = b.range.end.line;
      // nested symbols on the same line (e.g. const + object): keep the outermost
      if (seenLines.has(start)) {
        continue;
      }
      seenLines.add(start);
      const s = blockStats(heat, start, end);
      const share = fileCommits ? Math.round((s.commits.length / fileCommits) * 100) : 0;
      const title =
        s.commits.length === 0
          ? `❄️ No change during the period`
          : `🔥 ${plural(s.commits.length, 'commit')} (${share}% of the file) · ${plural(s.authors.size, 'author')} · ${ago(s.lastTs)}`;
      const args: BlockCommitsArgs = { uri: doc.uri.toString(), start, end, name: b.name };
      lenses.push(
        new vscode.CodeLens(new vscode.Range(start, 0, start, 0), {
          title,
          tooltip: s.authors.size ? `Authors: ${topAuthors(s.authors, 5)}` : undefined,
          command: s.commits.length ? 'githeat.showBlockCommits' : '',
          arguments: [args],
        }),
      );
    }
    return lenses;
  }
}

export async function showBlockCommits(service: HeatService, args: BlockCommitsArgs): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.uri));
  const state = service.repoFor(doc.uri);
  const heat = await service.lineHeatFor(doc)?.catch(() => undefined);
  if (!state || !heat) {
    return;
  }
  const s = blockStats(heat, args.start, args.end);
  const items = s.commits.map((idx) => {
    const c = heat.commits[idx];
    return {
      label: `$(git-commit) ${c.subject}`,
      description: `${c.author} · ${ago(c.ts)}`,
      detail: `${c.hash.slice(0, 7)} · ${formatDate(c.ts)}`,
      commit: c,
    };
  });
  const pick = await vscode.window.showQuickPick(items, {
    title: `GitHeat — ${args.name}: ${plural(items.length, 'commit')}`,
    placeHolder: 'Pick a commit to see its diff',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (pick) {
    await openCommitDiff(state.root, pick.commit.hash, pick.commit.path, pick.commit.subject);
  }
}

// --- commit diff through a content provider (git show <ref>:<path>) ---

export const REV_SCHEME = 'githeat-rev';

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly service: HeatService) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, ref } = JSON.parse(uri.query) as { root: string; ref: string };
    const rel = uri.path.replace(/^\//, '');
    return runGit(['show', `${ref}:${rel}`], { cwd: root, gitPath: this.service.gitPath() }).catch(() => '');
  }
}

function revUri(root: string, ref: string, rel: string): vscode.Uri {
  return vscode.Uri.from({ scheme: REV_SCHEME, path: `/${rel}`, query: JSON.stringify({ root, ref }) });
}

export async function openCommitDiff(root: string, hash: string, rel: string, subject = ''): Promise<void> {
  const title = `${path.posix.basename(rel)} (${hash.slice(0, 7)})${subject ? ` — ${subject}` : ''}`;
  await vscode.commands.executeCommand('vscode.diff', revUri(root, `${hash}^`, rel), revUri(root, hash, rel), title);
}
