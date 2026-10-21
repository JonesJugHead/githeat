/* Launches an isolated VS Code (downloaded into .vscode-test) with the extension, on a given repo.
   Usage: node out/test/runE2E.js <repo> <relativeFile> */
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const [repo, file] = process.argv.slice(2);
  process.env.GITHEAT_E2E_FILE = file;
  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, '../..'),
    extensionTestsPath: path.resolve(__dirname, './e2e'),
    launchArgs: [repo, '--disable-extensions', '--disable-workspace-trust'],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
