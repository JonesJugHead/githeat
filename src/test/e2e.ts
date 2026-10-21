import * as path from 'path';
import * as vscode from 'vscode';
import type { HeatService } from '../vscode/heatService';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<{ service: HeatService }>('JonesJugHead.githeat')!;
  await vscode.workspace.getConfiguration('githeat').update('since', '', vscode.ConfigurationTarget.Global);
  const api = await ext.activate();
  const service = api.service;

  for (let i = 0; i < 120 && !service.repoStates[0]?.heat; i++) {
    await wait(500);
  }
  while (service.isComputing) {
    await wait(500);
  }
  const state = service.repoStates[0];
  if (!state?.heat) {
    throw new Error('no heatmap computed');
  }
  console.log(`[e2e] repo ${state.root}: ${state.heat.files.size} hot files / ${state.heat.tracked.length} tracked`);

  const root = vscode.workspace.workspaceFolders![0].uri;
  const fileUri = vscode.Uri.joinPath(root, ...process.env.GITHEAT_E2E_FILE!.split('/'));
  const info = service.statsFor(fileUri);
  console.log(`[e2e] file: ${info?.stats?.commits} commits, heat ${info?.stats?.heat.toFixed(2)}, top ${((service.rankOf(info!.state, info!.rel) ?? 0) * 100).toFixed(1)}%`);
  const dirInfo = service.statsFor(vscode.Uri.file(path.dirname(fileUri.fsPath)));
  console.log(`[e2e] parent folder: ${dirInfo?.stats?.commits} commits, isDir=${dirInfo?.isDir}`);

  const doc = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(doc);
  const lh = await service.lineHeatFor(doc)!;
  console.log(`[e2e] lines: ${lh.lines.length}, max ${lh.maxTouches} changes/line`);

  // the TS server takes a few seconds to start
  let lenses: vscode.CodeLens[] = [];
  for (let i = 0; i < 20; i++) {
    lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', fileUri, 100)) ?? [];
    lenses = lenses.filter((l) => l.command?.title.match(/🔥|❄️/));
    if (lenses.length) {
      break;
    }
    await wait(1500);
  }
  console.log(`[e2e] GitHeat codelenses: ${lenses.length}`);
  for (const l of lenses.slice(0, 8)) {
    console.log(`   l.${l.range.start.line + 1}  ${l.command!.title}`);
  }

  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', fileUri, new vscode.Position(6, 2));
  const text = hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))
    .find((v) => v.includes('GitHeat'));
  console.log(`[e2e] hover line 7:\n${text?.split('\n').slice(0, 5).join('\n')}`);

  if (!lenses.length || !text || !info?.stats) {
    throw new Error('incomplete e2e');
  }
}
