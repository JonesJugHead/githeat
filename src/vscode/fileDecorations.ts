import * as vscode from 'vscode';
import { metricValue } from '../core/repoHeat';
import { tierOf } from '../core/scale';
import { ago, badge, METRIC_LABELS, statsSummary } from './format';
import { HeatService } from './heatService';

export function heatColor(tier: number): vscode.ThemeColor {
  return new vscode.ThemeColor(`githeat.heat${tier}`);
}

/** Colors files and folders directly in the built-in Explorer (and in our views). */
export class HeatDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly service: HeatService) {
    this.sub = service.onDidChange(() => this._onDidChange.fire(undefined));
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.service.settings.explorerEnabled) {
      return undefined;
    }
    const info = this.service.statsFor(uri);
    if (!info?.stats || info.rel === '') {
      return undefined;
    }
    const { stats, state, rel, isDir } = info;
    const tier = tierOf(stats.heat);
    if (tier === 0) {
      return undefined;
    }
    const metric = this.service.settings.metric;
    const rank = isDir ? undefined : this.service.rankOf(state, rel);
    const rankText = rank !== undefined ? ` · top ${Math.max(1, Math.round(rank * 100))}%` : '';
    return {
      badge: badge(metricValue(stats, metric)),
      color: heatColor(tier),
      tooltip: `GitHeat (${METRIC_LABELS[metric].toLowerCase()}): ${statsSummary(stats)}${rankText} · last change ${ago(stats.lastTs)}`,
      propagate: false,
    };
  }
}
