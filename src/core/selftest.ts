/* Quick core test (no VS Code): node out/core/selftest.js [existingRepo relativeFile] */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeLineHeat, blockStats } from './lineHeat';
import { computeRepoHeat } from './repoHeat';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('ok  -', msg);
  }
}

async function synthetic(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'githeat-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const write = (f: string, lines: string[]) => fs.writeFileSync(path.join(dir, f), lines.join('\n') + '\n');
  git('init', '-q');
  git('config', 'user.email', 'a@test');
  git('config', 'user.name', 'Alice');
  const commit = (msg: string, author = 'Alice <a@test>') => {
    git('add', '-A');
    git('commit', '-q', '-m', msg, `--author=${author}`);
  };

  write('a.ts', ['l1', 'l2', 'l3', 'l4', 'l5']);
  write('other.ts', ['x']);
  commit('init');
  write('a.ts', ['l1', 'l2', 'L3', 'l4', 'l5']);
  commit('edit l3', 'Bob <b@test>');
  write('a.ts', ['n1', 'n2', 'l1', 'l2', 'L3', 'l4', 'l5']);
  commit('insert top');
  write('a.ts', ['n1', 'n2', 'l1', 'l2', 'L3!', 'l4', 'l5']);
  commit('edit L3 again', 'Carol <c@test>');
  git('mv', 'a.ts', 'b.ts');
  commit('rename');
  write('b.ts', ['n1', 'n2', 'l1', 'l2', 'L3!', 'l5']);
  commit('delete l4');
  write('b.ts', ['n1', 'n2', 'l1', 'l2', 'L3!', 'l5', 'local']);
  write('bot.ts', ['y']);
  commit('bot', 'dependabot[bot] <bot@test>');

  // uncommitted local change
  write('b.ts', ['n1', 'n2', 'l1', 'l2', 'L3!', 'l5', 'local', 'wip']);

  const heat = await computeLineHeat({ cwd: dir, path: 'b.ts', lineCount: 8, since: '', excludeAuthors: '\\[bot\\]' });
  const counts = heat.lines.map((l) => l.touches.length);
  console.log('   touches per line:', counts.join(' '));
  assert(counts[4] === 4, 'L3: created + 2 edits + neighbour of the l4 deletion = 4 (tracked across insertion + rename)');
  assert(counts[5] === 2, 'l5: created + neighbour of the l4 deletion = 2');
  assert(counts[0] === 1 && counts[2] === 1, 'n1 and l1: a single commit');
  assert(counts[6] === 0, 'line added by a bot is ignored');
  assert(heat.lines[7].uncommitted && counts[7] === 0, 'local line marked as uncommitted');
  const b = blockStats(heat, 2, 5);
  assert(b.commits.length === 4 && b.authors.size === 3, 'block l1..l5: 4 commits, 3 authors');

  const repo = await computeRepoHeat({ cwd: dir, since: '', metric: 'commits', exclude: [], excludeAuthors: '\\[bot\\]' });
  assert(repo.files.get('b.ts')?.commits === 6, 'b.ts: 6 commits (a.ts history included through the rename)');
  assert(!repo.files.has('a.ts'), 'a.ts (old name) absent');
  assert(!repo.files.has('bot.ts'), 'file only touched by a bot absent');
  assert(repo.dirs.get('')?.commits === 6, 'root: 6 commits excluding the bot');
  fs.rmSync(dir, { recursive: true, force: true });
}

async function real(repo: string, file: string): Promise<void> {
  let t = Date.now();
  const heat = await computeRepoHeat({ cwd: repo, since: process.argv[4] ?? '', metric: 'commits', exclude: [], excludeAuthors: '\\[bot\\]' });
  console.log(`\nrepo ${repo}: ${heat.files.size} files, ${heat.totalCommits} commits in ${Date.now() - t} ms`);
  const top = [...heat.files.entries()].sort((a, b) => b[1].commits - a[1].commits).slice(0, 5);
  for (const [p, s] of top) {
    console.log(`   ${s.commits.toString().padStart(4)} commits  ${s.authors.size} authors  ${p}`);
  }
  if (file) {
    const lineCount = fs.readFileSync(path.join(repo, file), 'utf8').split('\n').length;
    t = Date.now();
    const lh = await computeLineHeat({ cwd: repo, path: file, lineCount, since: '', excludeAuthors: '' });
    console.log(`lines ${file}: ${lineCount} lines, ${lh.commits.length} commits, max ${lh.maxTouches} changes/line, ${Date.now() - t} ms`);
  }
}

(async () => {
  await synthetic();
  if (process.argv[2]) {
    await real(process.argv[2], process.argv[3] ?? '');
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
