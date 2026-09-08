import process from 'node:process';
import { resolveTool, runTool, packageRoot, VERSION } from './tooling.mjs';
import { config } from './config.mjs';
import { runtimeDirs } from './workspace.mjs';

const HINTS = {
  node: 'Install Node.js 20+ from https://nodejs.org and reopen the terminal.',
  npm: 'npm should ship with Node.js. Confirm `C:\\Program Files\\nodejs\\npm.cmd` exists.',
  git: 'Install Git for Windows and ensure git.exe is on PATH.',
  codex: 'Install Codex CLI (`npm i -g @openai/codex`) and confirm %APPDATA%\\npm is on PATH, or keep the global shim at %APPDATA%\\npm\\codex.cmd.',
  agy: 'Install Antigravity CLI so agy.exe exists at %LOCALAPPDATA%\\agy\\bin\\agy.exe.',
  agent: 'Install Cursor Agent CLI. Expected: %LOCALAPPDATA%\\cursor-agent\\agent.cmd or a versions\\<ver>\\cursor-agent.cmd. PATH is not required.',
};

function okLine(label, text) {
  return `OK ${label.padEnd(14)} ${text}`;
}

function errLine(label, text) {
  return `ERR ${label.padEnd(14)} ${text}`;
}

async function checkVersion(name, args = ['--version']) {
  const resolved = resolveTool(name);
  try {
    const r = await runTool(name, args, { timeoutMs: 30_000, quiet: true });
    if (r.code === 0) {
      const text = (r.stdout || r.stderr).trim().split(/\r?\n/)[0];
      return { ok: true, text: `${text}  [${resolved}]` };
    }
    return { ok: false, text: `${(r.stderr || r.stdout || `exit ${r.code}`).trim()}  [${resolved}]` };
  } catch (e) {
    return { ok: false, text: `${e.message}  [${resolved}]` };
  }
}

async function checkAuth(name, args, passRe, hint) {
  const resolved = resolveTool(name);
  try {
    const r = await runTool(name, args, { timeoutMs: 60_000, quiet: true });
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0 && passRe.test(text)) {
      return { ok: true, text: text.trim().split(/\r?\n/).filter(Boolean)[0] || 'authenticated' };
    }
    return { ok: false, text: hint };
  } catch (e) {
    return { ok: false, text: `${hint} (${e.message})  [${resolved}]` };
  }
}

console.log(`AI Orchestrator v${VERSION}\n`);

const checks = [
  ['Node', 'node'],
  ['npm', 'npm'],
  ['Git', 'git'],
  ['Codex', 'codex'],
  ['Antigravity', 'agy'],
  ['Cursor Agent', 'agent'],
];

let failed = false;
for (const [label, name] of checks) {
  const r = await checkVersion(name);
  console.log(r.ok ? okLine(label, r.text) : errLine(label, r.text));
  if (!r.ok) {
    console.log(`   -> ${HINTS[name]}`);
    failed = true;
  }
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) {
  console.log(errLine('Node', `Node ${process.versions.node} is too old. Node 20+ required.`));
  failed = true;
}

console.log('\nAuthentication:');
const auths = [
  ['Codex', () => checkAuth('codex', ['login', 'status'], /logged in/i, 'Run `codex login` then retry `npm run doctor`.')],
  ['Antigravity', () => checkAuth('agy', ['models'], /gemini|claude|gpt|model/i, 'Sign in to Antigravity, then retry. `agy models` must succeed without modifying files.')],
  ['Cursor', () => checkAuth('agent', ['status'], /logged in/i, 'Run the resolved agent.cmd with `login`, then retry `npm run cursor-test`.')],
];

for (const [label, fn] of auths) {
  const r = await fn();
  console.log(r.ok ? okLine(label, r.text) : errLine(label, r.text));
  if (!r.ok) failed = true;
}

const dirs = runtimeDirs();
console.log('\nTimeouts:');
console.log(`  Cursor  ${config.cursorTimeoutMs} ms  (AI_CURSOR_TIMEOUT_MS)`);
console.log(`  Codex   ${config.codexTimeoutMs} ms  (AI_CODEX_TIMEOUT_MS)`);
console.log(`  Gemini  ${config.geminiTimeoutMs} ms  (AI_GEMINI_TIMEOUT_MS)`);
console.log(`  Tests   ${config.testTimeoutMs} ms  (AI_TEST_TIMEOUT_MS)`);
console.log(`  Retries ${config.workerMaxRetries}  (AI_WORKER_MAX_RETRIES)`);
console.log('\nDirectories:');
console.log(`  Package   ${packageRoot()}`);
console.log(`  Worktrees ${dirs.worktrees}`);
console.log(`  Runs      ${dirs.runs}`);
console.log(`  Keep success worktrees: ${config.keepSuccessWorktrees}`);
console.log(`  Keep failed worktrees:  ${config.keepFailedWorktrees}`);

process.exitCode = failed ? 1 : 0;
