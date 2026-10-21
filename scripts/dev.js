// Opens a VS Code window with the extension in development mode, without a debugger.
// Usage: npm run dev -- path/to/a/repo
const { spawn } = require('child_process');
const path = require('path');

const ext = path.resolve(__dirname, '..');
const repo = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const args = ['--new-window', `--extensionDevelopmentPath=${ext}`, ...(repo ? [repo] : [])];
spawn('code', args.map((a) => `"${a}"`), { shell: true, stdio: 'inherit', detached: true }).unref();
