import * as vscode from 'vscode';
import { Metric } from './core/repoHeat';
import { BlockCodeLensProvider, BlockCommitsArgs, EditorHeatController, openCommitDiff, REV_SCHEME, RevisionContentProvider, showBlockCommits } from './vscode/editorHeat';
import { HeatDecorationProvider } from './vscode/fileDecorations';
import { METRIC_LABELS, metricShort } from './vscode/format';
import { getGitApi } from './vscode/gitApi';
import { HeatService, readSettings } from './vscode/heatService';
import { HeatTreeProvider, HotspotsProvider } from './vscode/treeView';

const PERIODS: { label: string; since: string }[] = [
  { label: '1 month', since: '1 month ago' },
  { label: '3 months', since: '3 months ago' },
  { label: '6 months', since: '6 months ago' },
  { label: '1 year', since: '1 year ago' },
  { label: '2 years', since: '2 years ago' },
  { label: 'Whole history', since: '' },
];

export async function activate(context: vscode.ExtensionContext): Promise<{ service: HeatService } | undefined> {
  const git = await getGitApi();
  if (!git) {
    void vscode.window.showWarningMessage('GitHeat: the built-in VS Code Git extension is disabled.');
    return undefined;
  }

  const service = new HeatService(git, context.globalStorageUri);
  const decorations = new HeatDecorationProvider(service);
  const tree = new HeatTreeProvider(service);
  const hotspots = new HotspotsProvider(service);
  const editorHeat = new EditorHeatController(service, context.extensionUri);
  const codeLens = new BlockCodeLensProvider(service);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'githeat.pickPeriod';

  const treeView = vscode.window.createTreeView('githeat.tree', { treeDataProvider: tree, showCollapseAll: true });
  const updateTreeMessage = () => {
    const s = service.settings;
    treeView.message = service.isComputing
      ? 'Analyzing history…'
      : `${METRIC_LABELS[s.metric]} · ${PERIODS.find((p) => p.since === s.since)?.label ?? s.since}`;
  };

  const updateStatus = () => {
    const editor = vscode.window.activeTextEditor;
    if (service.isComputing) {
      status.text = '$(sync~spin) GitHeat';
      status.tooltip = 'Analyzing git history…';
      status.show();
      return;
    }
    const info = editor ? service.statsFor(editor.document.uri) : undefined;
    if (!info) {
      status.hide();
      return;
    }
    const rank = service.rankOf(info.state, info.rel);
    status.text = info.stats
      ? `$(flame) ${metricShort(info.stats, service.settings.metric)}${rank !== undefined ? ` · top ${Math.max(1, Math.round(rank * 100))}%` : ''}`
      : '$(flame) cold';
    status.tooltip = `GitHeat — period: ${service.settings.since || 'whole history'} (click to change)`;
    status.show();
  };

  context.subscriptions.push(
    service,
    decorations,
    tree,
    hotspots,
    editorHeat,
    codeLens,
    status,
    treeView,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.window.registerTreeDataProvider('githeat.hotspots', hotspots),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLens),
    vscode.workspace.registerTextDocumentContentProvider(REV_SCHEME, new RevisionContentProvider(service)),
    service.onDidChange(() => {
      updateStatus();
      updateTreeMessage();
    }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),

    vscode.commands.registerCommand('githeat.refresh', () => service.refreshAll(true)),
    vscode.commands.registerCommand('githeat.pickPeriod', async () => {
      const current = service.settings.since;
      const pick = await vscode.window.showQuickPick(
        [...PERIODS.map((p) => ({ ...p, description: p.since === current ? '(current)' : undefined })), { label: 'Custom…', since: '__custom__' }],
        { title: 'GitHeat — analyzed period' },
      );
      if (!pick) {
        return;
      }
      let since = pick.since;
      if (since === '__custom__') {
        const v = await vscode.window.showInputBox({ prompt: 'git --since format (e.g. "2025-01-01", "10 weeks ago")', value: current });
        if (v === undefined) {
          return;
        }
        since = v;
      }
      await vscode.workspace.getConfiguration('githeat').update('since', since, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('githeat.pickMetric', async () => {
      const pick = await vscode.window.showQuickPick(
        (Object.keys(METRIC_LABELS) as Metric[]).map((m) => ({ label: METRIC_LABELS[m], metric: m, description: m === service.settings.metric ? '(current)' : undefined })),
        { title: 'GitHeat — heat metric' },
      );
      if (pick) {
        await vscode.workspace.getConfiguration('githeat').update('metric', pick.metric, vscode.ConfigurationTarget.Global);
      }
    }),
    vscode.commands.registerCommand('githeat.toggleLineHeat', async () => {
      const c = vscode.workspace.getConfiguration('githeat');
      await c.update('lines.enabled', !c.get('lines.enabled', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('githeat.toggleExplorerHeat', async () => {
      const c = vscode.workspace.getConfiguration('githeat');
      await c.update('explorer.enabled', !c.get('explorer.enabled', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('githeat.toggleSort', () => {
      tree.sort = tree.sort === 'heat' ? 'name' : 'heat';
      tree.refresh();
    }),
    vscode.commands.registerCommand('githeat.showBlockCommits', (args: BlockCommitsArgs) => showBlockCommits(service, args)),
    vscode.commands.registerCommand('githeat.openCommitDiff', (root: string, hash: string, rel: string, subject?: string) =>
      openCommitDiff(root, hash, rel, subject),
    ),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('githeat')) {
        return;
      }
      if (['since', 'exclude', 'excludeAuthors', 'lines.maxCommits'].some((k) => e.affectsConfiguration(`githeat.${k}`))) {
        void service.refreshAll(false);
      } else if (e.affectsConfiguration('githeat.metric')) {
        service.applyMetric();
      } else {
        service.settings = readSettings();
        decorations.refresh();
        codeLens.refresh();
        hotspots.refresh();
      }
      if (e.affectsConfiguration('githeat.lines')) {
        editorHeat.recreate();
      }
      updateTreeMessage();
    }),
  );

  updateTreeMessage();
  updateStatus();
  return { service };
}

export function deactivate(): void {}
