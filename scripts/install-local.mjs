// Builds the plugin and installs it into the local Claude Code from this folder.
//   npm run setup -- http://192.168.1.50:8000 [--dry-run]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const given = args.find((arg) => !arg.startsWith('--'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const claude = process.platform === 'win32' ? 'claude.cmd' : 'claude';

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg);

// The .cmd shims on Windows need a shell; a single command string keeps arguments (paths with spaces) intact.
function spawn(command, commandArgs) {
  const options = { cwd: root, encoding: 'utf8' };
  return process.platform === 'win32'
    ? spawnSync([command, ...commandArgs].map(quote).join(' '), { ...options, shell: true })
    : spawnSync(command, commandArgs, options);
}

function run(command, commandArgs, { allow } = {}) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`);
  if (dryRun && command !== npm) return { status: 0, output: '' };
  const result = spawn(command, commandArgs);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0 && !(allow && allow.test(output))) {
    fail(`${command} ${commandArgs[0]} failed (exit ${result.status}).`);
  }
  return { status: result.status, output };
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  fail(`Node.js 22.13 or newer is required (found ${process.versions.node}); it provides node:sqlite for the stats.`);
}

if (!dryRun) {
  const check = spawn(claude, ['--version']);
  if (check.status !== 0) fail('The claude command was not found on PATH.');
  console.log(`Claude Code ${check.stdout.trim()}`);
}

run(npm, ['ci']);
run(npm, ['run', 'build']);

if (!existsSync(resolve(root, 'dist', 'request.js'))) fail('The build did not produce dist/request.js.');
const { layaServerUrl } = await import(pathToFileURL(resolve(root, 'dist', 'request.js')).href);

let url = given;
if (!url) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  url = await rl.question('Laya server URL (e.g. http://192.168.1.50:8000): ');
  rl.close();
}
let server;
try {
  server = layaServerUrl(url);
} catch (error) {
  fail(error.message);
}

run(claude, ['plugin', 'marketplace', 'add', root], { allow: /already/i });
run(claude, ['plugin', 'install', 'laya-compaction@laya-compaction', '--config', `baseUrl=${server}`], {
  allow: /already/i,
});

console.log(`
Installed from ${root} (loaded in place, so run "npm run build" and /reload-plugins after edits).
Laya server: ${server}

Function hooks are early access. Make sure Claude Code is 2.1.274+ and that
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 is set where it runs, e.g. in ~/.claude/settings.json:
  { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
Then restart Claude Code and run /laya-status, later /laya-stats.
`);
