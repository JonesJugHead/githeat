import * as vscode from 'vscode';

// Typed subset of the built-in vscode.git extension API (see extensions/git/src/api/git.d.ts).
export interface GitRepositoryState {
  readonly HEAD: { readonly commit?: string; readonly name?: string } | undefined;
  readonly onDidChange: vscode.Event<void>;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
}

export interface GitAPI {
  readonly git: { readonly path: string };
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

export async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) {
    return undefined;
  }
  const exports = ext.isActive ? ext.exports : await ext.activate();
  try {
    return exports.getAPI(1);
  } catch {
    // git extension disabled by the user ("git.enabled": false)
    return undefined;
  }
}
