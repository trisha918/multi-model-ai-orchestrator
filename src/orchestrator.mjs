import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { isWin, resolveTool, VERSION } from './tooling.mjs';
import { resolveRoute, classifyTask } from './router.mjs';
import {
  inspectSourceRepo,
  formatDirtyFiles,
  gitState,
  createIsolatedWorktree,
  commitChanges,
  runtimeDirs,
  makeRunId,
  shouldTrustCursorWorkspace,
  sourceFingerprint,
  workingTreeChanged,
  removeOrchestratorWorktree,
  resolveTaskRepo,
} from './workspace.mjs';
import { buildCursorAgentArgs, runCursorAgentCli } from './cursor-agent.mjs';
import { executeProcess } from './process.mjs';
import { runProjectTests } from './test-runner.mjs';
import { loadResolvedConfig, loadConfig } from './config.mjs';
import { resolveTaskInput, TaskInputError } from './task-input.mjs';
import { workerPrompts } from './prompts.mjs';
import { teamLoopShouldStartFix } from './team-loop.mjs';
import { loadRegistry } from './model-cache.mjs';
import { ModelSelectionError } from './model-registry.mjs';
import { modelsJsonPayload, resolveRunModels } from './model-select.mjs';

let config = loadConfig();

export function parseTaskArgs(argv, defaults = {}) {
  const out = {
    mode: defaults.defaultMode || 'auto',
    repo: '',
    task: '',
    windowsUnelevated: false,
    maxFixRounds: 2,
    inPlace: false,
    commitOnPass: false,
    branch: '',
    cursorModel: defaults.cursorModel || 'auto',
    codexModel: defaults.codexModel || 'auto',
    geminiModel: defaults.geminiModel || 'auto',
    model: '',
    modelId: '',
    provided: { mode: false, cursorModel: false, codexModel: false, geminiModel: false, model: false, modelId: false, task: false, taskFile: false, taskStdin: false },
    taskFile: '',
    taskStdin: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i] ?? '';
    else if (a === '--task') {
      out.task = argv[++i] ?? '';
      out.provided.task = true;
    } else if (a === '--task-file') {
      out.taskFile = argv[++i] ?? '';
      out.provided.taskFile = true;
    } else if (a === '--task-stdin') {
      out.taskStdin = true;
      out.provided.taskStdin = true;
    } else if (a === '--mode') {
      out.mode = argv[++i] ?? 'auto';
      out.provided.mode = true;
    } else if (a === '--windows-unelevated') out.windowsUnelevated = true;
    else if (a === '--max-fix-rounds') out.maxFixRounds = Math.max(0, Math.min(5, Number(argv[++i] ?? 2)));
    else if (a === '--in-place') out.inPlace = true;
    else if (a === '--commit-on-pass') out.commitOnPass = true;
    else if (a === '--branch') out.branch = argv[++i] ?? '';
    else if (a === '--cursor-model') {
      out.cursorModel = argv[++i] ?? 'auto';
      out.provided.cursorModel = true;
    } else if (a === '--codex-model') {
      out.codexModel = argv[++i] ?? 'auto';
      out.provided.codexModel = true;
    } else if (a === '--gemini-model') {
      out.geminiModel = argv[++i] ?? 'auto';
      out.provided.geminiModel = true;
    } else if (a === '--model') {
      out.model = argv[++i] ?? '';
      out.provided.model = true;
    } else if (a === '--model-id') {
      out.modelId = argv[++i] ?? '';
      out.provided.modelId = true;
    }
  }
  if (!out.provided.mode && defaults.defaultMode) out.mode = defaults.defaultMode;
  if (!out.provided.cursorModel && defaults.cursorModel) out.cursorModel = defaults.cursorModel;
  if (!out.provided.codexModel && defaults.codexModel) out.codexModel = defaults.codexModel;
  if (!out.provided.geminiModel && defaults.geminiModel) out.geminiModel = defaults.geminiModel;
  return out;
}

function fmtSec(ms) {
  if (!ms && ms !== 0) return '';
  const s = ms / 1000;
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

function confidencePct(c) {
  return `${Math.round((Number(c) || 0) * 100)}%`;
}

function printTimeoutArg(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return `${minutes}m`;
}

function banner({ task, route, reason, confidence, workspace, branch, modelInfo }) {
  const lines = [
    '========================================',
    'AI ORCHESTRATOR',
    '========================================',
    '',
    'Task:',
    task,
    '',
    'Route:',
    route,
    '',
    'Route Confidence:',
    confidencePct(confidence),
    '',
    'Reason:',
    reason,
  ];
  if (route === 'TEAM' && modelInfo?.stages) {
    const s = modelInfo.stages;
    lines.push('', 'TEAM MODEL POLICY', '');
    lines.push('Planning:', 'Cursor', `Profile: ${s.plan.profile}`, `Model: ${s.plan.model || '(unresolved)'}`, '');
    lines.push('Implementation:', 'Codex', `Profile: ${s.implementation.profile}`, `Model: ${s.implementation.model || '(unresolved)'}`, '');
    lines.push('Review:', 'Gemini', `Profile: ${s.review.profile}`, `Model: ${s.review.model || '(unresolved)'}`, '');
    lines.push('Fix:', 'Codex', `Profile: ${s.fix.profile}`, `Model: ${s.fix.model || '(unresolved)'}`);
  } else if (modelInfo?.worker) {
    const w = modelInfo.worker;
    lines.push('', 'Model Selection:', w.manual ? 'MANUAL' : 'AUTO');
    if (w.manual) {
      lines.push('', 'Requested Alias:', w.requestedAlias || w.model);
    } else {
      lines.push('', 'Model Profile:', w.profile || 'auto');
      if (w.fallback && w.preferred) {
        lines.push('', 'Preferred:', w.preferred, 'Resolved:', w.profile, 'Reason:', w.reason);
      }
    }
    lines.push('', 'Resolved Model:', w.model || '(provider default)');
    lines.push('', 'Model Reason:', w.reason || '');
  }
  lines.push('', 'Workspace:', workspace, '', 'Branch:', branch);
  lines.push('', '========================================', '');
  return lines.join('\n');
}

function summaryBlock(info) {
  const failed = Boolean(info.failedStage) || info.ok === false;
  const lines = [
    '',
    '==================================================',
    failed ? 'TASK FAILED' : 'TASK COMPLETE',
    '==================================================',
    '',
    'Route:',
    info.route,
    '',
    'Confidence:',
    confidencePct(info.confidence),
    '',
  ];
  if (info.route === 'TEAM') {
    lines.push(`Cursor Plan:\n${info.plan}${info.planMs ? ` (${fmtSec(info.planMs)})` : ''}`, '');
    lines.push(`Codex Implementation:\n${info.implementation}${info.implMs ? ` (${fmtSec(info.implMs)})` : ''}`, '');
  } else if (info.route === 'CURSOR') {
    lines.push(`Cursor Implementation:\n${info.implementation}${info.implMs ? ` (${fmtSec(info.implMs)})` : ''}`, '');
  } else if (info.route === 'CODEX') {
    lines.push(`Codex Implementation:\n${info.implementation}${info.implMs ? ` (${fmtSec(info.implMs)})` : ''}`, '');
  } else {
    lines.push(`Gemini Analysis:\n${info.review}${info.reviewMs ? ` (${fmtSec(info.reviewMs)})` : ''}`, '');
  }

  lines.push('Tests:', info.tests);
  if (info.testRunner) lines.push(info.testRunner);
  if (info.tests === 'SKIP' && info.testReason) {
    lines.push('Reason:', info.testReason);
  } else if (info.testDurationMs != null && info.tests !== 'SKIP') {
    lines.push(fmtSec(info.testDurationMs));
  }
  if (info.tests === 'FAIL' && info.testCommand) {
    lines.push('', 'Command:', info.testCommand, 'Exit code:', String(info.testExitCode ?? ''));
  }
  lines.push('');
  if (info.route === 'TEAM') {
    lines.push(`Gemini Review:\n${info.review}${info.reviewMs ? ` (${fmtSec(info.reviewMs)})` : ''}`, '');
    lines.push(`Fix Rounds:\n${info.fixRounds ?? 0}`, '');
  }
  if (info.failedStage) {
    lines.push('Failed stage:', info.failedStage, '');
  }
  lines.push('Branch:', info.branch || '(none)', '');
  lines.push('Commit:', info.commit || 'none', '');
  lines.push('Run Log:', info.runLog, '');
  lines.push('Main Workspace Modified:', info.mainModified ? 'YES' : 'NO', '');
  lines.push('Worktree:', info.worktreeState || '(none)');
  lines.push('==================================================');
  return lines.join('\n');
}

function workerUsage({ worker, model, durationMs, attempts, extra = {} }) {
  return {
    worker,
    model: model || 'unknown',
    durationMs,
    attempts: attempts || 1,
    usage: extra.usage || 'unavailable',
    ...extra,
  };
}

function throwIfBad(r, label) {
  if (r.timedOut) {
    const err = new Error(`${label} timed out after ${fmtSec(r.durationMs)}`);
    err.stageStatus = 'TIMEOUT';
    throw err;
  }
  if (r.exitCode !== 0) {
    const err = new Error(`${label} failed (${r.exitCode})\n${r.stderr || r.stdout || ''}`);
    err.stageStatus = 'FAIL';
    throw err;
  }
}

async function antigravity(repo, prompt, model = '') {
  console.log('\n--- GEMINI / ANTIGRAVITY ---\n');
  if (model) console.log(`Model: ${model}\n`);
  const cmd = resolveTool('agy');
  const args = ['-p', prompt];
  if (model) args.push('--model', model);
  args.push(
    '--output-format', 'json',
    '--print-timeout', printTimeoutArg(config.geminiTimeoutMs),
    '--mode', 'plan',
    '--sandbox',
    '--dangerously-skip-permissions',
  );
  const r = await executeProcess(cmd, args, {
    cwd: repo,
    timeoutMs: config.geminiTimeoutMs,
    quiet: true,
    maxRetries: config.workerMaxRetries,
  });
  throwIfBad(r, 'Antigravity');
  let response = r.stdout;
  let usage = 'unavailable';
  try {
    const parsed = JSON.parse(r.stdout);
    if (parsed.status && parsed.status !== 'SUCCESS') {
      throw new Error(`Antigravity status=${parsed.status}: ${parsed.error ?? 'unknown error'}`);
    }
    response = parsed.response ?? r.stdout;
    if (parsed.usage) usage = parsed.usage;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  return { text: response, proc: r, usage };
}

async function cursorAgent(repo, prompt, model = 'auto', readOnly = false, runContext = {}) {
  console.log(`\n--- CURSOR AGENT (${model}) ---\n`);
  const trust = shouldTrustCursorWorkspace(repo, runContext);
  if (trust) console.log('Cursor workspace trust: enabled (verified isolated worktree)\n');
  else console.log('Cursor workspace trust: not auto-applied for this path\n');
  const args = buildCursorAgentArgs({ prompt, model, readOnly, trust });
  const r = await runCursorAgentCli(args, {
    cwd: repo,
    timeoutMs: config.cursorTimeoutMs,
    maxRetries: config.workerMaxRetries,
  });
  throwIfBad(r, 'Cursor Agent');
  return { text: r.stdout, proc: r };
}

async function codex(repo, prompt, windowsUnelevated, model = '') {
  console.log('\n--- CODEX ---\n');
  if (model) console.log(`Model: ${model}\n`);
  const args = [];
  if (isWin && windowsUnelevated) args.push('-c', 'windows.sandbox="unelevated"');
  if (model) args.push('-m', model);
  args.push('--ask-for-approval', 'never', 'exec', '--sandbox', 'workspace-write', '-');
  const r = await executeProcess(resolveTool('codex'), args, {
    cwd: repo,
    input: prompt,
    timeoutMs: config.codexTimeoutMs,
    maxRetries: config.workerMaxRetries,
  });
  if (r.exitCode !== 0 || r.timedOut) {
    const combined = `${r.stdout}\n${r.stderr}`;
    if (isWin && !windowsUnelevated && /helper_unknown_error|orchestrator_helper_incomplete|sandbox setup/i.test(combined)) {
      throw new Error('Codex Windows sandbox failed. Re-run with --windows-unelevated, or run the orchestrator inside WSL2.');
    }
  }
  throwIfBad(r, 'Codex');
  return { text: r.stdout, proc: r };
}

function reviewDecision(review) {
  const lines = String(review || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const first = (lines[0] ?? '').toUpperCase();
  if (first === 'PASS') return 'PASS';
  if (first === 'NEEDS_FIXES') return 'NEEDS_FIXES';
  if (/\bNEEDS_FIXES\b/i.test(review)) return 'NEEDS_FIXES';
  if (/\bPASS\b/i.test(review)) return 'PASS';
  return 'UNKNOWN';
}

async function geminiReadOnly(repo, prompt, runDir, model = '') {
  const before = await gitState(repo);
  const prefixed = `READ ONLY. DO NOT MODIFY FILES. DO NOT RUN DESTRUCTIVE COMMANDS.\n${prompt}`;
  const out = await antigravity(repo, prefixed, model);
  const after = await gitState(repo);
  if (workingTreeChanged(before, after)) {
    await writeFile(path.join(runDir, 'gemini-safety.diff'), after.diff, 'utf8');
    const err = new Error('SAFETY VIOLATION: Gemini/Antigravity modified the worktree. Review rejected.');
    err.stageStatus = 'SAFETY';
    throw err;
  }
  return out;
}

async function independentTests(repo, runDir) {
  console.log('\n--- INDEPENDENT TESTS ---\n');
  const r = await runProjectTests(repo, { timeoutMs: config.testTimeoutMs, quiet: false });
  const body = [
    `status=${r.status}`,
    `runner=${r.runner || '(none)'}`,
    `command=${r.command || '(none)'}`,
    `exitCode=${r.exitCode}`,
    `durationMs=${r.durationMs}`,
    r.reason ? `reason=${r.reason}` : '',
    '',
    r.stdout || '',
    r.stderr || '',
  ].filter(Boolean).join('\n');
  await writeFile(path.join(runDir, 'tests.txt'), body, 'utf8');
  return r;
}

export async function runTask(argv = process.argv.slice(2), options = {}) {
  config = options.config || await loadResolvedConfig(options.env || process.env);
  const args = parseTaskArgs(argv, config);
  args.env = options.env || process.env;
  try {
    args.task = await resolveTaskInput(args, { stdin: options.stdin || process.stdin });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    if (e instanceof TaskInputError && /Missing task/.test(msg)) {
      console.error('Usage: ai-orchestrator run --repo "<git-root>" (--task "Your task" | --task-file <path> | --task-stdin) [--mode auto|cursor|codex|gemini|agy|team] [--model auto] [--model-id <id>] [--cursor-model auto] [--codex-model auto] [--gemini-model auto] [--max-fix-rounds 2] [--commit-on-pass] [--branch ai/my-task] [--in-place] [--windows-unelevated]');
      console.error('Also: npm run task -- --repo "<git-root>" --task "Your task" ...');
    }
    process.exitCode = e instanceof TaskInputError ? e.exitCode : 2;
    return process.exitCode;
  }

  if ((options.env || process.env).AI_ORCHESTRATOR_PRINT_TASK_AND_EXIT === '1' || options.printTaskAndExit) {
    process.stdout.write(args.task);
    return 0;
  }

  try {
    args.repo = await resolveTaskRepo(args.repo, options.cwd || process.cwd());
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
    return 2;
  }

  let route;
  try {
    route = resolveRoute(args.task, args.mode);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
    return 2;
  }

  let sourceInfo;
  try {
    sourceInfo = await inspectSourceRepo(args.repo);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
    return 2;
  }

  if (!args.inPlace && sourceInfo.status.trim()) {
    console.error('\nREFUSED: source repository has uncommitted changes.');
    console.error('Nothing was discarded, reset, or cleaned.');
    console.error('Commit or stash these files, then retry. Isolation will not silently ignore local edits.\n');
    console.error(formatDirtyFiles(sourceInfo.status));
    process.exitCode = 3;
    return 3;
  }

  const startedAt = Date.now();
  const runId = makeRunId(args.task);
  const dirs = runtimeDirs(options.env || process.env);
  const runDir = path.join(dirs.runs, runId);
  await mkdir(runDir, { recursive: true });

  let modelResolved;
  try {
    const loaded = await loadRegistry({ env: options.env || process.env, refresh: false });
    const analysis = classifyTask(args.task);
    modelResolved = resolveRunModels({
      task: args.task,
      route: route.route,
      args,
      config,
      registry: loaded.registry,
      classification: analysis,
    });
    await writeFile(path.join(runDir, 'models.json'), JSON.stringify(modelsJsonPayload({ route: route.route, resolved: modelResolved }), null, 2), 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeFile(path.join(runDir, 'error.txt'), msg, 'utf8');
    console.error(msg);
    process.exitCode = e instanceof ModelSelectionError ? 2 : 1;
    return process.exitCode;
  }

const routeRecord = {
  route: route.route,
  reason: route.reason,
  complexity: route.complexity,
  risk: route.risk,
  confidence: route.confidence ?? 1,
  timestamp: new Date().toISOString(),
};
await writeFile(path.join(runDir, 'task.txt'), args.task, 'utf8');
await writeFile(path.join(runDir, 'route.json'), JSON.stringify(routeRecord, null, 2), 'utf8');

const meta = {
  version: VERSION,
  runId,
  sourceRepo: sourceInfo.root,
  sourceBranch: sourceInfo.branch,
  sourceHead: sourceInfo.head,
  requestedMode: args.mode,
  route: route.route,
  inPlace: args.inPlace,
  commitOnPass: args.commitOnPass,
  cursorModel: args.cursorModel,
  maxFixRounds: args.maxFixRounds,
};
const timings = { totalMs: 0, cursorMs: 0, codexMs: 0, testsMs: 0, geminiMs: 0 };
const stages = [];
const usageLog = [];
const startFingerprint = sourceFingerprint(sourceInfo);

let repo = sourceInfo.root;
let worktree = '';
let taskBranch = sourceInfo.branch;
let isolatedMeta = { runId, createdByOrchestrator: false };
let cursorRunContext = { runId, createdByOrchestrator: false };
const result = {
  route: route.route,
  confidence: route.confidence ?? 1,
  plan: 'SKIP',
  implementation: 'SKIP',
  tests: 'SKIP',
  review: 'SKIP',
  failedStage: '',
  branch: taskBranch,
  commit: 'none',
  runLog: runDir,
  mainModified: Boolean(args.inPlace),
  worktreeState: args.inPlace ? 'IN-PLACE' : 'ACTIVE',
  ok: true,
  fixRounds: 0,
};

function addStage(name, status, durationMs) {
  stages.push({ name, status, durationMs: durationMs || 0 });
}

try {
  if (!args.inPlace) {
    const isolated = await createIsolatedWorktree(sourceInfo.root, args.task, args.branch, runId);
    repo = isolated.worktree;
    worktree = isolated.worktree;
    taskBranch = isolated.branch;
    isolatedMeta = { runId: isolated.runId, createdByOrchestrator: true };
    cursorRunContext = isolatedMeta;
    result.branch = taskBranch;
    meta.worktree = worktree;
    meta.taskBranch = taskBranch;
  } else {
    console.log('\nWARNING: --in-place disables Git isolation. Agents will operate directly in the source repository.\n');
    meta.worktree = sourceInfo.root;
    meta.taskBranch = taskBranch;
  }

  await writeFile(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  process.stdout.write(banner({
    task: args.task,
    route: route.route,
    reason: route.reason,
    confidence: route.confidence,
    workspace: repo,
    branch: taskBranch,
    modelInfo: modelResolved,
  }));

  let planText = '';
  let implementationText = '';
  let reviewText = '';
  let tests = { status: 'SKIP', reason: 'Not a modifying route', durationMs: 0, command: '', runner: '', exitCode: null };
  let finalDecision = 'SUCCESS';

  const prompts = workerPrompts(args.task);
  const codingPrompt = prompts.coding;
  const sendToWorker = (kind, text) => {
    if (typeof options.onWorkerPrompt === 'function') options.onWorkerPrompt({ kind, text });
    return text;
  };

  const cursorModelId = route.route === 'TEAM' ? (modelResolved.stages.plan.model || 'auto') : (modelResolved.worker?.model || args.cursorModel || 'auto');
  const codexModelId = route.route === 'TEAM' ? (modelResolved.stages.implementation.model || '') : (modelResolved.worker?.model || '');
  const geminiModelId = route.route === 'TEAM' ? (modelResolved.stages.review.model || '') : (modelResolved.worker?.model || '');
  const codexFixModelId = route.route === 'TEAM' ? (modelResolved.stages.fix.model || codexModelId) : codexModelId;

  if (route.route === 'CURSOR') {
    result.implementation = 'FAIL';
    const out = await cursorAgent(repo, sendToWorker('cursor-implementation', codingPrompt), cursorModelId, false, cursorRunContext);
    await writeFile(path.join(runDir, 'implementation.txt'), out.text, 'utf8');
    result.implementation = 'PASS';
    result.implMs = out.proc.durationMs;
    timings.cursorMs += out.proc.durationMs;
    addStage('cursor-implementation', 'PASS', out.proc.durationMs);
    usageLog.push(workerUsage({ worker: 'cursor', model: cursorModelId, durationMs: out.proc.durationMs, attempts: out.proc.attempts }));
    tests = await independentTests(repo, runDir);
  } else if (route.route === 'GEMINI') {
    result.review = 'FAIL';
    const out = await geminiReadOnly(repo, sendToWorker('gemini-analysis', prompts.geminiAnalysis), runDir, geminiModelId);
    await writeFile(path.join(runDir, 'review.txt'), out.text, 'utf8');
    result.review = 'PASS';
    result.reviewMs = out.proc.durationMs;
    timings.geminiMs += out.proc.durationMs;
    addStage('gemini-analysis', 'PASS', out.proc.durationMs);
    usageLog.push(workerUsage({ worker: 'gemini', model: geminiModelId || 'antigravity', durationMs: out.proc.durationMs, attempts: out.proc.attempts, extra: { usage: out.usage } }));
    console.log('\n\nFINAL (Gemini/Antigravity):\n', out.text);
  } else if (route.route === 'CODEX') {
    result.implementation = 'FAIL';
    const out = await codex(repo, sendToWorker('codex-implementation', codingPrompt), args.windowsUnelevated, codexModelId);
    await writeFile(path.join(runDir, 'implementation.txt'), out.text, 'utf8');
    result.implementation = 'PASS';
    result.implMs = out.proc.durationMs;
    timings.codexMs += out.proc.durationMs;
    addStage('codex-implementation', 'PASS', out.proc.durationMs);
    usageLog.push(workerUsage({ worker: 'codex', model: codexModelId || 'codex', durationMs: out.proc.durationMs, attempts: out.proc.attempts }));
    tests = await independentTests(repo, runDir);
  } else {
    result.plan = 'FAIL';
    const plan = await cursorAgent(repo, sendToWorker('cursor-plan', prompts.plan), cursorModelId, true, cursorRunContext);
    planText = plan.text;
    await writeFile(path.join(runDir, 'plan.txt'), planText, 'utf8');
    result.plan = 'PASS';
    result.planMs = plan.proc.durationMs;
    timings.cursorMs += plan.proc.durationMs;
    addStage('cursor-plan', 'PASS', plan.proc.durationMs);
    usageLog.push(workerUsage({ worker: 'cursor', model: cursorModelId, durationMs: plan.proc.durationMs, attempts: plan.proc.attempts }));

    result.implementation = 'FAIL';
    const implementation = await codex(repo, sendToWorker('codex-implementation', prompts.implementation(planText)), args.windowsUnelevated, codexModelId);
    implementationText = implementation.text;
    await writeFile(path.join(runDir, 'implementation.txt'), implementationText, 'utf8');
    result.implementation = 'PASS';
    result.implMs = implementation.proc.durationMs;
    timings.codexMs += implementation.proc.durationMs;
    addStage('codex-implementation', 'PASS', implementation.proc.durationMs);
    usageLog.push(workerUsage({ worker: 'codex', model: codexModelId || 'codex', durationMs: implementation.proc.durationMs, attempts: implementation.proc.attempts }));

    tests = await independentTests(repo, runDir);
    timings.testsMs += tests.durationMs || 0;
    addStage('tests', tests.status, tests.durationMs || 0);

    let round = 0;
    let decision = 'UNKNOWN';
    for (;;) {
      if (tests.status === 'PASS' || tests.status === 'SKIP') {
        result.review = 'FAIL';
        const review = await geminiReadOnly(repo, sendToWorker(round === 0 ? 'gemini-review' : `gemini-review-${round}`, prompts.review), runDir, geminiModelId);
        reviewText = review.text;
        await writeFile(path.join(runDir, 'review.txt'), reviewText, 'utf8');
        decision = reviewDecision(reviewText);
        result.reviewMs = (result.reviewMs || 0) + review.proc.durationMs;
        timings.geminiMs += review.proc.durationMs;
        addStage(round === 0 ? 'gemini-review' : `gemini-review-${round}`, decision === 'PASS' ? 'PASS' : decision, review.proc.durationMs);
        usageLog.push(workerUsage({ worker: 'gemini', model: geminiModelId || 'antigravity', durationMs: review.proc.durationMs, attempts: review.proc.attempts, extra: { usage: review.usage } }));
        console.log(`\n\nREVIEW DECISION: ${decision}\n`);
        if (decision === 'PASS') break;
      } else {
        decision = 'TESTS_FAIL';
      }

      if (!teamLoopShouldStartFix({
        testsStatus: tests.status,
        decision,
        round,
        maxFixRounds: args.maxFixRounds,
      })) break;

      round += 1;
      console.log(`\n=== AUTO-FIX ROUND ${round}/${args.maxFixRounds} ===\n`);
      result.implementation = 'FAIL';
      const fixPrompt = [
        prompts.fixHeader,
        planText ? `\nPlan:\n---\n${planText}\n---` : '',
        `\nCurrent implementation context:\n---\n${implementationText}\n---`,
        tests.status === 'FAIL' || tests.status === 'TIMEOUT' ? `\nIndependent tests ${tests.status}. Command: ${tests.command}\nExit code: ${tests.exitCode}\nOutput:\n${tests.stdout}\n${tests.stderr}` : '',
        reviewText && decision === 'NEEDS_FIXES' ? `\nA strict reviewer found these issues:\n---\n${reviewText}\n---` : '',
        '\nFix ONLY the material issues. Do not commit or push.',
      ].join('\n');
      const fix = await codex(repo, sendToWorker(`codex-fix-${round}`, fixPrompt), args.windowsUnelevated, codexFixModelId);
      implementationText = fix.text;
      await writeFile(path.join(runDir, `fix-round-${round}.txt`), fix.text, 'utf8');
      result.implementation = 'PASS';
      timings.codexMs += fix.proc.durationMs;
      addStage(`codex-fix-${round}`, 'PASS', fix.proc.durationMs);
      usageLog.push(workerUsage({ worker: 'codex', model: codexFixModelId || 'codex', durationMs: fix.proc.durationMs, attempts: fix.proc.attempts }));

      tests = await independentTests(repo, runDir);
      timings.testsMs += tests.durationMs || 0;
      addStage(`tests-${round}`, tests.status, tests.durationMs || 0);
    }

    result.fixRounds = round;
    meta.finalDecision = decision;
    meta.fixRounds = round;
    finalDecision = decision === 'PASS' && (tests.status === 'PASS' || tests.status === 'SKIP') ? 'PASS' : decision;
    result.review = decision === 'PASS' ? 'PASS' : decision;
    if (tests.status === 'FAIL' || tests.status === 'TIMEOUT') {
      result.failedStage = `Independent tests (${tests.status})`;
      result.ok = false;
    } else if (decision !== 'PASS') {
      result.failedStage = `Gemini Review (${decision})`;
      result.ok = false;
    }
    if (!result.ok) console.log(`\nWorkflow stopped with decision=${finalDecision}. No commit/push was performed.`);
    if (reviewText) console.log('\n\nFINAL REVIEW (Gemini/Antigravity):\n', reviewText);
  }

  if (route.route !== 'TEAM') {
    timings.testsMs += tests.durationMs || 0;
    if (route.route !== 'GEMINI') addStage('tests', tests.status, tests.durationMs || 0);
  }

  result.tests = tests.status;
  result.testRunner = tests.command || tests.runner || '';
  result.testReason = tests.reason || '';
  result.testDurationMs = tests.durationMs;
  result.testCommand = tests.command;
  result.testExitCode = tests.exitCode;
  if (tests.status === 'FAIL' || tests.status === 'TIMEOUT') {
    result.ok = false;
    if (!result.failedStage) result.failedStage = `Independent tests (${tests.status})`;
  }

  const after = await gitState(repo);
  if (after.patch.trim() || after.status.trim()) {
    await writeFile(path.join(runDir, 'diff.patch'), after.patch || after.diff, 'utf8');
  }

  const endSource = await inspectSourceRepo(sourceInfo.root);
  if (!args.inPlace && sourceFingerprint(endSource) !== startFingerprint) {
    result.ok = false;
    result.failedStage = 'SAFETY FAILURE';
    result.mainModified = true;
    console.error('\nSAFETY FAILURE: source workspace changed unexpectedly. Nothing was reset.\n');
    console.error(formatDirtyFiles(endSource.status));
  }

  let commitResult = { committed: false, reason: 'commit not requested', hash: '' };
  const testsOk = tests.status === 'PASS' || tests.status === 'SKIP';
  const implOk = result.implementation === 'PASS' || route.route === 'GEMINI';
  const reviewOk = route.route !== 'TEAM' || result.review === 'PASS';
  const mayCommit = args.commitOnPass
    && result.ok
    && implOk
    && testsOk
    && reviewOk
    && route.route !== 'GEMINI'
    && result.failedStage !== 'SAFETY FAILURE';
  if (mayCommit) {
    console.log('\n--- LOCAL COMMIT ---\n');
    commitResult = await commitChanges(repo, args.task);
    console.log(commitResult.committed ? `Committed locally: ${commitResult.hash}` : `No commit created: ${commitResult.reason}`);
  } else if (args.commitOnPass) {
    commitResult = { committed: false, reason: result.failedStage || `tests=${tests.status} review=${result.review}`, hash: '' };
    console.log(`\nCommit skipped (${commitResult.reason}).`);
  }

  const success = result.ok && testsOk && (route.route !== 'TEAM' || result.review === 'PASS');
  let worktreeState = worktree ? 'PRESERVED FOR DEBUGGING' : (args.inPlace ? 'IN-PLACE' : '(none)');
  if (worktree && isolatedMeta.createdByOrchestrator) {
    const keep = success ? config.keepSuccessWorktrees : config.keepFailedWorktrees;
    if (!keep && success) {
      const rm = await removeOrchestratorWorktree({
        sourceRepo: sourceInfo.root,
        worktree,
        runId: isolatedMeta.runId,
        createdByOrchestrator: true,
      });
      worktreeState = rm.removed ? 'CLEANED' : `PRESERVED (${rm.reason})`;
    }
  }
  result.worktreeState = worktreeState;

  timings.totalMs = Date.now() - startedAt;
  meta.commitCreated = commitResult.committed;
  meta.commitHash = commitResult.hash;
  meta.commitReason = commitResult.reason;
  meta.worktreeState = worktreeState;
  await writeFile(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  await writeFile(path.join(runDir, 'timings.json'), JSON.stringify(timings, null, 2), 'utf8');
  await writeFile(path.join(runDir, 'stages.json'), JSON.stringify(stages, null, 2), 'utf8');
  await writeFile(path.join(runDir, 'usage.json'), JSON.stringify(usageLog, null, 2), 'utf8');

  result.commit = commitResult.hash || (commitResult.reason ? commitResult.reason : 'none');
  if (!success) result.ok = false;
  console.log(summaryBlock(result));
  if (!result.ok) process.exit(1);
} catch (err) {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  await writeFile(path.join(runDir, 'error.txt'), msg, 'utf8');
  const st = err?.stageStatus;
  if (!result.failedStage) {
    if (st === 'TIMEOUT') result.failedStage = 'TIMEOUT';
    else if (st === 'SAFETY') result.failedStage = 'SAFETY VIOLATION';
    else if (result.plan === 'FAIL') result.failedStage = 'Cursor Plan';
    else if (result.implementation === 'FAIL') result.failedStage = route.route === 'CURSOR' ? 'Cursor Implementation' : 'Codex Implementation';
    else if (result.review === 'FAIL') result.failedStage = route.route === 'GEMINI' ? 'Gemini Analysis' : 'Gemini Review';
    else result.failedStage = 'Orchestrator';
  }
  result.ok = false;
  result.worktreeState = worktree ? 'PRESERVED FOR DEBUGGING' : result.worktreeState;
  timings.totalMs = Date.now() - startedAt;
  await writeFile(path.join(runDir, 'meta.json'), JSON.stringify({ ...meta, error: msg }, null, 2), 'utf8');
  await writeFile(path.join(runDir, 'timings.json'), JSON.stringify(timings, null, 2), 'utf8');
  await writeFile(path.join(runDir, 'stages.json'), JSON.stringify(stages, null, 2), 'utf8');
  console.error('\nFAILED:\n', msg);
  console.log(summaryBlock(result));
  if (worktree) console.error(`\nThe isolated worktree was kept for debugging:\n${worktree}`);
  process.exitCode = 1;
  return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const code = await runTask(process.argv.slice(2));
  if (typeof code === 'number' && code !== 0) process.exit(code);
}
