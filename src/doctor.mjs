import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { existsSync } from 'node:fs';
import { resolveTool, runTool, packageRoot, VERSION } from './tooling.mjs';
import { loadResolvedConfig } from './config.mjs';
import { installationInfo, requiredNodeEngine } from './paths.mjs';
import { skillStatus, CORE_SKILLS } from './skills.mjs';
import { loadRegistry } from './model-cache.mjs';
import { nodeSatisfiesEngine } from './install-helpers.mjs';
import { collectGithubDoctor, formatGithubDoctor } from './github-doctor.mjs';

export const HINTS = {
  node: 'Install Node.js 20+ from https://nodejs.org and reopen the terminal. Do not let the orchestrator installer install Node for you.',
  npm: 'npm should ship with Node.js. Confirm npm.cmd exists next to node.exe or on PATH.',
  git: 'Install Git for Windows and ensure git.exe is on PATH.',
  codex: 'MISSING Codex CLI. Required for CODEX and TEAM routes. Install with `npm i -g @openai/codex` and confirm %APPDATA%\\npm is on PATH, or keep the global shim at %APPDATA%\\npm\\codex.cmd.',
  agy: 'MISSING Antigravity CLI. Required for GEMINI and TEAM review. Install so agy.exe exists at %LOCALAPPDATA%\\agy\\bin\\agy.exe.',
  agent: 'MISSING Cursor Agent CLI. Required for CURSOR and TEAM plan. Expected: %LOCALAPPDATA%\\cursor-agent\\agent.cmd or a versions\\<ver>\\cursor-agent.cmd. PATH is not required. Do not assume agent.exe exists.',
};

export async function checkVersion(name, args = ['--version']) {
  const resolved = resolveTool(name);
  try {
    const r = await runTool(name, args, { timeoutMs: 30_000, quiet: true });
    if (r.code === 0) {
      const text = (r.stdout || r.stderr).trim().split(/\r?\n/)[0];
      return { ok: true, text: `${text}  [${resolved}]`, resolved };
    }
    return { ok: false, text: `${(r.stderr || r.stdout || `exit ${r.code}`).trim()}  [${resolved}]`, resolved };
  } catch (e) {
    return { ok: false, text: `${e.message}  [${resolved}]`, resolved };
  }
}

export async function checkAuth(name, args, passRe, hint) {
  const resolved = resolveTool(name);
  try {
    const r = await runTool(name, args, { timeoutMs: 60_000, quiet: true });
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0 && passRe.test(text)) {
      return { ok: true, text: text.trim().split(/\r?\n/).filter(Boolean)[0] || 'authenticated', resolved };
    }
    return { ok: false, text: hint, resolved };
  } catch (e) {
    return { ok: false, text: `${hint} (${e.message})  [${resolved}]`, resolved };
  }
}

export async function collectDoctorReport(env = process.env) {
  const config = await loadResolvedConfig(env);
  const info = installationInfo(env);
  let models = { registry: null, fromCache: false, error: '' };
  try {
    models = await loadRegistry({ env, refresh: false });
  } catch (e) {
    models = { registry: null, fromCache: false, error: e instanceof Error ? e.message : String(e) };
  }
  const skills = skillStatus(env, models.registry);

  const node = await checkVersion('node');
  const npm = await checkVersion('npm');
  const git = await checkVersion('git');
  const codex = await checkVersion('codex');
  const agy = await checkVersion('agy');
  const agent = await checkVersion('agent');

  const nodeEngineOk = nodeSatisfiesEngine(process.versions.node, requiredNodeEngine());
  if (!nodeEngineOk) {
    node.ok = false;
    node.text = `Node ${process.versions.node} does not satisfy engines.node ${requiredNodeEngine()}.`;
  }

  const auths = {
    cursor: await checkAuth('agent', ['status'], /logged in/i, 'ACTION REQUIRED: run the resolved Cursor Agent with `login` (typically the discovered agent.cmd / cursor-agent.cmd). Then retry `ai-orchestrator doctor`.'),
    codex: await checkAuth('codex', ['login', 'status'], /logged in/i, 'ACTION REQUIRED: run `codex login`, then retry `ai-orchestrator doctor`.'),
    agy: await checkAuth('agy', ['models'], /gemini|claude|gpt|model/i, 'ACTION REQUIRED: sign in to Antigravity, then confirm `agy models` succeeds without modifying files.'),
  };

  if (!agent.ok) auths.cursor = { ok: false, text: 'Cursor Agent CLI was not found, so authentication cannot be checked.' };
  if (!codex.ok) auths.codex = { ok: false, text: 'Codex CLI was not found, so authentication cannot be checked.' };
  if (!agy.ok) auths.agy = { ok: false, text: 'Antigravity CLI was not found, so authentication cannot be checked.' };

  const coreMissing = skills.filter(s => CORE_SKILLS.some(c => c.name === s.name) && !s.ok);
  const failed = !node.ok || !npm.ok || !git.ok || !codex.ok || !agy.ok || !agent.ok
    || !auths.cursor.ok || !auths.codex.ok || !auths.agy.ok
    || coreMissing.length > 0;

  return {
    version: VERSION,
    packageRoot: packageRoot(),
    info,
    config,
    checks: { node, npm, git, agent, codex, agy },
    auths,
    skills,
    models,
    github: await collectGithubDoctor({ env, cwd: process.cwd() }),
    failed,
    ready: !failed,
  };
}

export function formatDoctor(report) {
  const lines = [];
  const v = report.version.startsWith('v') ? report.version : `v${report.version}`;
  lines.push(`Multi-Model AI Orchestrator ${v.replace(/^v/, 'v')}`);
  lines.push('');
  lines.push('CLI:');
  lines.push('OK');
  lines.push('');
  lines.push('Node:');
  lines.push(report.checks.node.ok ? `OK v${process.versions.node}` : `ERR ${report.checks.node.text}`);
  if (!report.checks.node.ok) lines.push(`   -> ${HINTS.node}`);
  lines.push('');
  lines.push('npm:');
  lines.push(report.checks.npm.ok ? `OK ${report.checks.npm.text}` : `ERR ${report.checks.npm.text}`);
  if (!report.checks.npm.ok) lines.push(`   -> ${HINTS.npm}`);
  lines.push('');
  lines.push('Git:');
  lines.push(report.checks.git.ok ? 'OK' : `ERR ${report.checks.git.text}`);
  if (!report.checks.git.ok) lines.push(`   -> ${HINTS.git}`);
  lines.push('');
  lines.push('Cursor Agent:');
  lines.push(report.checks.agent.ok ? 'OK' : `ERR ${report.checks.agent.text}`);
  if (!report.checks.agent.ok) lines.push(`   -> ${HINTS.agent}`);
  lines.push('');
  lines.push('Codex:');
  lines.push(report.checks.codex.ok ? 'OK' : `ERR ${report.checks.codex.text}`);
  if (!report.checks.codex.ok) lines.push(`   -> ${HINTS.codex}`);
  lines.push('');
  lines.push('Gemini:');
  lines.push(report.checks.agy.ok ? 'OK' : `ERR ${report.checks.agy.text}`);
  if (!report.checks.agy.ok) lines.push(`   -> ${HINTS.agy}`);
  lines.push('');
  lines.push('Authentication:');
  lines.push(report.auths.cursor.ok ? 'Cursor: OK' : `Cursor: ACTION REQUIRED — ${report.auths.cursor.text}`);
  lines.push(report.auths.codex.ok ? 'Codex: OK' : `Codex: ACTION REQUIRED — ${report.auths.codex.text}`);
  lines.push(report.auths.agy.ok ? 'Antigravity: OK' : `Antigravity: ACTION REQUIRED — ${report.auths.agy.text}`);
  lines.push('');
  lines.push('Cursor Skills:');
  for (const s of report.skills) {
    const mark = s.ok ? 'OK' : s.status === 'missing' ? 'MISSING' : (s.status === 'legacy' ? 'LEGACY (upgrade with install-skills)' : s.status.toUpperCase());
    lines.push(`/${s.name.padEnd(22)} ${mark}`);
  }
  lines.push('');
  lines.push('Model discovery:');
  const providers = report.models?.registry?.providers || {};
  const cursorModels = providers.cursor;
  const codexModels = providers.codex;
  const geminiModels = providers.gemini;
  const statusLine = (bucket, okWorker) => {
    if (!bucket) return okWorker ? 'unavailable (worker may still function)' : 'unavailable';
    if (bucket.status === 'ok') return `OK (${(bucket.models || []).length} models, ${bucket.source})`;
    if (bucket.status === 'partial') return `partial (${bucket.source || 'limited local evidence'})`;
    return `unavailable${okWorker ? ' (worker may still function)' : ''}`;
  };
  lines.push(`Cursor models: ${statusLine(cursorModels, report.checks.agent.ok)}`);
  lines.push(`Codex models: ${statusLine(codexModels, report.checks.codex.ok)}`);
  lines.push(`Gemini models: ${statusLine(geminiModels, report.checks.agy.ok)}`);
  if (report.models?.error) lines.push(`Discovery error: ${report.models.error}`);
  lines.push(`Model cache: ${report.info.modelsCachePath}${report.models?.fromCache ? ' (hit)' : ''}`);
  lines.push('');
  lines.push('Config:');
  lines.push(report.info.configPath);
  lines.push('');
  lines.push('Runtime:');
  lines.push(report.info.runtimeRoot);
  lines.push(`  Runs      ${report.info.runs}`);
  lines.push(`  Worktrees ${report.info.worktrees}`);
  if (existsSync(report.info.legacyRuns) || existsSync(report.info.legacyWorktrees)) {
    lines.push(`  Legacy clone artifacts (still cleaned if present):`);
    lines.push(`    ${report.info.legacyRuns}`);
    lines.push(`    ${report.info.legacyWorktrees}`);
  }
  lines.push('');
  lines.push('Installation:');
  lines.push(report.packageRoot);
  lines.push('');
  lines.push('Timeouts:');
  lines.push(`  Cursor  ${report.config.cursorTimeoutMs} ms  (AI_CURSOR_TIMEOUT_MS)`);
  lines.push(`  Codex   ${report.config.codexTimeoutMs} ms  (AI_CODEX_TIMEOUT_MS)`);
  lines.push(`  Gemini  ${report.config.geminiTimeoutMs} ms  (AI_GEMINI_TIMEOUT_MS)`);
  lines.push(`  Tests   ${report.config.testTimeoutMs} ms  (AI_TEST_TIMEOUT_MS)`);
  lines.push(`  Retries ${report.config.workerMaxRetries}  (AI_WORKER_MAX_RETRIES)`);
  lines.push('');
  lines.push(formatGithubDoctor(report.github));
  lines.push('');
  lines.push(report.ready ? 'READY' : 'NOT READY');
  return lines.join('\n');
}

export function formatInstallSummary(report) {
  const status = (ok) => (ok ? 'OK' : 'MISSING');
  const skill = (name) => {
    const s = report.skills.find(x => x.name === name);
    return s?.ok ? 'OK' : (s?.status === 'missing' ? 'MISSING' : (s?.status === 'legacy' ? 'LEGACY' : 'CHECK'));
  };
  const v = String(report.version).replace(/^v/, '');
  return [
    '========================================',
    `Multi-Model AI Orchestrator v${v.split('.').slice(0, 2).join('.')}`,
    '========================================',
    '',
    `CLI               OK`,
    `Cursor Agent      ${status(report.checks.agent.ok)}`,
    `Codex             ${status(report.checks.codex.ok)}`,
    `Gemini            ${status(report.checks.agy.ok)}`,
    `/ai Skill         ${skill('ai')}`,
    `/ai-team Skill    ${skill('ai-team')}`,
    `/ai-models Skill  ${skill('ai-models')}`,
    '',
    'Installation:',
    report.packageRoot,
    '',
    'Status:',
    report.ready ? 'READY' : 'NOT READY — see doctor output above',
    '',
    'Open a Git project in Cursor and type:',
    '',
    '/ai Fix a bug and add tests',
    '========================================',
  ].join('\n');
}

export async function runDoctor() {
  const report = await collectDoctorReport();
  console.log(formatDoctor(report));
  console.log('');
  console.log(formatInstallSummary(report));
  process.exitCode = report.failed ? 1 : 0;
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await runDoctor();
}

