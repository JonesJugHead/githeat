import { spawn } from 'child_process';

export interface GitOptions {
  /** Path to the git executable (provided by the vscode.git extension when available). */
  gitPath?: string;
  cwd: string;
  signal?: AbortSignal;
}

/** Runs a git command and returns its whole stdout (handles very large histories). */
export function runGit(args: string[], opts: GitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.gitPath ?? 'git', args, {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', reject);
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) {
        reject(new Error('aborted'));
      } else if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'));
      } else {
        reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(err).toString('utf8').trim()}`));
      }
    });
  });
}

export function sinceArgs(since: string): string[] {
  return since.trim() ? [`--since=${since.trim()}`] : [];
}
