# GitHeat

A git history heatmap inside VS Code: see which files, folders, code blocks and lines of a repository change the most.

## Why

When you join a codebase, or come back to one, the hard part is knowing where things actually happen.
The files that change all the time are usually where the bugs, the complexity and the knowledge live.
`git log` can tell you, but not at a glance. GitHeat paints that information directly where you already
look: the Explorer, the editor gutter and above each function.

## Screenshot / GIF

<!-- TODO: add a GIF showing the colored Explorer, the gutter heat and a CodeLens being clicked. -->
_Coming soon._

## What it shows

| Where | What |
|---|---|
| **Built-in Explorer** | Files and folders colored from blue (warm) to red (burning), plus a badge with the metric value. Tooltip: commits, authors, churn, rank in the repo. |
| **GitHeat view** (flame icon in the Activity Bar) | A *Tree* of the repo sorted by heat (or by name) and a *Hottest files* list. |
| **Editor gutter** | A colored bar per line: how many times each line changed (tracked across insertions, deletions and renames). Also visible in the scrollbar. |
| **Above functions / classes / methods** | `🔥 112 commits (87% of the file) · 11 authors · 2 years ago`. Click to list the block's commits, then open a diff. |
| **Line hover** | The commits that touched the line, clickable to open the diff. |
| **Status bar** | Heat of the current file and its rank (`top 3%`). Click to change the period. |

Blocks are detected through VS Code's language servers (document symbols), so it works for TS/JS/React,
PHP, C#, Python, Go and any other language that provides symbols.

## Installation

From a `.vsix` (until it is published on the Marketplace):

```bash
npm install
npm run package          # creates githeat-<version>.vsix
code --install-extension githeat-0.1.0.vsix
```

Or in VS Code: Extensions view → `…` → *Install from VSIX…*.
Uninstall with `code --uninstall-extension JonesJugHead.githeat`.

Requirements: VS Code 1.90+ with the built-in Git extension enabled.

## Usage

Open a folder that contains a git repository. GitHeat analyzes the history in the background and colors the
Explorer as soon as it is done. Then:

- click the flame icon in the Activity Bar for the tree and the hottest files;
- use the calendar button (or click the status bar) to change the analyzed period;
- use the graph button to switch between `commits`, `churn` and `authors`;
- click a CodeLens above a function to browse the commits that touched it.

## Settings (`githeat.*`)

| Setting | Default | Purpose |
|---|---|---|
| `since` | `6 months ago` | Analyzed period (`git --since` format). Empty = the whole history. Also available through the calendar button. |
| `metric` | `commits` | `commits`, `churn` (lines added + deleted) or `authors`. |
| `exclude` | lockfiles, `dist`, `build`, `*.min.js`… | Ignored globs. |
| `excludeAuthors` | `\[bot\]\|dependabot\|renovate` | Regex of ignored authors. |
| `explorer.enabled` / `lines.enabled` / `codeLens.enabled` | `true` | Turn each display on or off. |
| `lines.background` | `false` | Also tint the line background. |
| `lines.maxCommits` | `1000` | Maximum number of commits replayed per file for line-by-line heat. |
| `hotspots.limit` | `50` | Number of files in the *Hottest files* view. |

Colors can be customized through `workbench.colorCustomizations` (`githeat.heat1` to `githeat.heat5`).
Dates follow the VS Code display language.

## How it works

- **Repository**: a single `git log --numstat -M` over the period (renames followed), aggregated per file and
  per folder. The result is cached on disk per HEAD: it is only recomputed when HEAD moves (commit, pull, checkout).
- **Lines**: when a file opens, `git log --follow -p -U0` is replayed from newest to oldest while tracking the
  position of every current line. A changed line keeps its history; a deletion counts for the neighbouring lines.
  Uncommitted local changes are flagged separately.
- Uses the git binary and the repositories detected by VS Code's built-in Git extension (multi-repo supported).
- Log scale normalized on the 95th percentile, so a few extreme files do not flatten the rest.

## Development

```bash
npm install
npm run compile
npm run dev -- path/to/a/repo     # opens an Extension Development Host on that repo, without debugger
```

After a change: `npm run compile` (or `npm run watch`), then `Ctrl+R` in the development window.
With a debugger: open this folder in VS Code and press F5. If "Extension host did not start in 10 seconds"
appears, use `Ctrl+F5` (run without debugging) or `npm run dev`.

Layout:

```
src/
  core/        pure git analysis, no VS Code dependency (reusable for a CLI or a web app)
  vscode/      integration: service + cache, Explorer, views, editor, diff
  extension.ts entry point, commands, status bar
  test/        e2e test in an isolated VS Code
```

Tests:

```bash
npm run compile
npm run test:core                                      # core tests on a synthetic git repo
node out/core/selftest.js path/to/repo                 # + stats on a real repo
node out/test/runE2E.js path/to/repo relative/file.ts  # e2e in an isolated VS Code (downloaded into .vscode-test)
```

## License

[MIT](LICENSE) © JonesJugHead
