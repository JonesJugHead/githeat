import * as path from 'path';
import * as vscode from 'vscode';
import { HeatStats, metricValue, RepoHeat } from '../core/repoHeat';
import { tierOf } from '../core/scale';
import { ago, metricShort, statsSummary, topAuthors } from './format';
import { HeatService } from './heatService';

type RepoState = HeatService['repoStates'][number];

interface Node {
  state: RepoState;
  /** relative path ('' = repo root) */
  rel: string;
  kind: 'repo' | 'dir' | 'file';
}

interface DirIndex {
  dirs: Map<string, Set<string>>;
  files: Map<string, string[]>;
}

export type SortMode = 'heat' | 'name';

const indexes = new WeakMap<RepoHeat, DirIndex>();

function dirIndex(heat: RepoHeat): DirIndex {
  let idx = indexes.get(heat);
  if (idx) {
    return idx;
  }
  idx = { dirs: new Map(), files: new Map() };
  for (const file of heat.tracked) {
    const parts = file.split('/');
    let parent = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parent ? `${parent}/${parts[i]}` : parts[i];
      let set = idx.dirs.get(parent);
      if (!set) {
        idx.dirs.set(parent, (set = new Set()));
      }
      set.add(dir);
      parent = dir;
    }
    const list = idx.files.get(parent) ?? [];
    list.push(file);
    idx.files.set(parent, list);
  }
  indexes.set(heat, idx);
  return idx;
}

function tooltip(rel: string, s: HeatStats | undefined, rank?: number): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${rel || '/'}**\n\n`);
  if (!s) {
    md.appendMarkdown('❄️ No change during the period');
    return md;
  }
  md.appendMarkdown(`$(flame) ${statsSummary(s)}\n\n`);
  if (rank !== undefined) {
    md.appendMarkdown(`$(graph) Top ${Math.max(1, Math.round(rank * 100))}% of the repo files\n\n`);
  }
  md.appendMarkdown(`$(person) ${topAuthors(s.authors)}\n\n`);
  md.appendMarkdown(`$(history) Last changed ${ago(s.lastTs)}`);
  return md;
}

/** Explorer-like repo tree, sorted by heat. */
export class HeatTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private readonly sub: vscode.Disposable;
  sort: SortMode = 'heat';

  constructor(private readonly service: HeatService) {
    this.sub = service.onDidChange(() => this._onDidChange.fire(undefined));
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const states = this.service.repoStates.filter((s) => s.heat);
      if (states.length === 1) {
        return this.childrenOf(states[0], '');
      }
      return states.map((state) => ({ state, rel: '', kind: 'repo' }));
    }
    return node.kind === 'file' ? [] : this.childrenOf(node.state, node.rel);
  }

  private childrenOf(state: RepoState, rel: string): Node[] {
    const heat = state.heat;
    if (!heat) {
      return [];
    }
    const idx = dirIndex(heat);
    const metric = this.service.settings.metric;
    const dirs: Node[] = [...(idx.dirs.get(rel) ?? [])].map((d) => ({ state, rel: d, kind: 'dir' }));
    const files: Node[] = (idx.files.get(rel) ?? []).map((f) => ({ state, rel: f, kind: 'file' }));
    const name = (n: Node) => path.posix.basename(n.rel).toLowerCase();
    const value = (n: Node) => {
      const s = n.kind === 'dir' ? heat.dirs.get(n.rel) : heat.files.get(n.rel);
      return s ? metricValue(s, metric) : 0;
    };
    const cmp = this.sort === 'heat' ? (a: Node, b: Node) => value(b) - value(a) || name(a).localeCompare(name(b)) : (a: Node, b: Node) => name(a).localeCompare(name(b));
    return [...dirs.sort(cmp), ...files.sort(cmp)];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const { state, rel, kind } = node;
    const heat = state.heat!;
    const uri = vscode.Uri.file(path.join(state.root, ...rel.split('/').filter(Boolean)));
    if (kind === 'repo') {
      const item = new vscode.TreeItem(path.basename(state.root), vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('repo');
      item.description = `${heat.totalCommits} commits · ${heat.since || 'whole history'}`;
      return item;
    }
    const stats = kind === 'dir' ? heat.dirs.get(rel) : heat.files.get(rel);
    const item = new vscode.TreeItem(uri, kind === 'dir' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `${state.root}|${rel}`;
    item.description = stats ? metricShort(stats, this.service.settings.metric) : '';
    item.tooltip = tooltip(rel, stats, kind === 'file' ? this.service.rankOf(state, rel) : undefined);
    if (kind === 'file') {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
      item.contextValue = 'githeat.file';
    }
    return item;
  }
}

/** Flat list of the hottest files, across all repositories. */
export class HotspotsProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly service: HeatService) {
    this.sub = service.onDidChange(() => this._onDidChange.fire(undefined));
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (node) {
      return [];
    }
    const metric = this.service.settings.metric;
    const all: { node: Node; v: number; h: number }[] = [];
    for (const state of this.service.repoStates) {
      for (const [rel, s] of state.heat?.files ?? []) {
        all.push({ node: { state, rel, kind: 'file' }, v: metricValue(s, metric), h: s.heat });
      }
    }
    return all
      .sort((a, b) => b.h - a.h || b.v - a.v)
      .slice(0, this.service.settings.hotspotsLimit)
      .map((x) => x.node);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const { state, rel } = node;
    const stats = state.heat!.files.get(rel)!;
    const uri = vscode.Uri.file(path.join(state.root, ...rel.split('/')));
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(rel);
    item.description = `${metricShort(stats, this.service.settings.metric)}${dir !== '.' ? ` · ${dir}` : ''}`;
    item.tooltip = tooltip(rel, stats, this.service.rankOf(state, rel));
    item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
    // Explorer not colored: a colored flame acts as a visual cue
    if (!this.service.settings.explorerEnabled) {
      item.iconPath = new vscode.ThemeIcon('flame', new vscode.ThemeColor(`githeat.heat${Math.max(1, tierOf(stats.heat))}`));
    }
    return item;
  }
}
