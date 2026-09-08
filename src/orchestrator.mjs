import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isWin, resolveTool, VERSION } from './tooling.mjs';
import { resolveRoute, teamRoles } from './router.mjs';
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
} from './workspace.mjs';
import { buildCursorAgentArgs, runCursorAgentCli } from './cursor-agent.mjs';
import { executeProcess } from './process.mjs';
import { runProjectTests } from './test-runner.mjs';
import { config } from './config.mjs';

function parseArgs(argv) {
  const out = {
    mode: 'auto',
    repo: '',
    task: '',
    windowsUnelevated: false,
    maxFixRounds: 2,
    inPlace: false,
    commitOnPass: false,
    branch: '',
    cursorModel: 'auto',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i] ?? '';
    else if (a === '--task') out.task = argv[++i] ?? '';
    else if (a === '--mode') out.mode = argv[++i] ?? 'auto';
    else if (a === '--windows-unelevated') out.windowsUnelevated = true;
    else if (a === '--max-fix-rounds') out.maxFixRounds = Math.max(0, Math.min(5, Number(argv[++i] ?? 2)));
    else if (a === '--in-place') out.inPlace = true;
    else if (a === '--commit-on-pass') out.commitOnPass = true;
    else if (a === '--branch') out.branch = argv[++i] ?? '';
    else if (a === '--cursor-model') out.cursorModel = argv[++i] ?? 'auto';
  }
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

function banner({ task, route, reason, confidence, workspace, branch }) {
  const lines = [
    '==============================',
    'AI ORCHESTRATOR',
    '==============================',
    '',
    'Task:',
    task,
    '',
    'Route:',
    route,
    '',
    'Confidence:',
    confidencePct(confidence),
    '',
    'Reason:',
    reason,
    '',
    'Workspace:',
    workspace,
    '',
    'Branch:',
    branch,
  ];
  if (route === 'TEAM') {
    const roles = teamRoles();
    lines.push('', `Plan: ${roles.plan}`, `Implementation: ${roles.implementation}`, `Review: ${roles.review}`);
  }
  lines.push('', '==============================', '');
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

async function antigravity(repo, prompt) {
  console.log('\n--- GEMINI / ANTIGRAVITY ---\n');
  const cmd = resolveTool('agy');
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--print-timeout', printTimeoutArg(config.geminiTimeoutMs),
    '--mode', 'plan',
    '--sandbox',
    '--dangerously-skip-permissions',
  ];
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

async function codex(repo, prompt, windowsUnelevated) {
  console.log('\n--- CODEX ---\n');
  const args = [];
  if (isWin && windowsUnelevated) args.push('-c', 'windows.sandbox="unelevated"');
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

async function geminiReadOnly(repo, prompt, runDir) {
  const before = await gitState(repo);
  const prefixed = `READ ONLY. DO NOT MODIFY FILES. DO NOT RUN DESTRUCTIVE COMMANDS.\n${prompt}`;
  const out = await antigravity(repo, prefixed);
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

const args = parseArgs(process.argv.slice(2));
if (!args.repo || !args.task) {
  console.error('Usage: npm run task -- --repo "C:\\path\\to\\repo" --task "Your task" [--mode auto|cursor|codex|gemini|agy|team] [--max-fix-rounds 2] [--commit-on-pass] [--branch ai/my-task] [--in-place] [--windows-unelevated]');
  process.exit(2);
}

let route;
try {
  route = resolveRoute(args.task, args.mode);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}

let sourceInfo;
try {
  sourceInfo = await inspectSourceRepo(args.repo);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}

if (!args.inPlace && sourceInfo.status.trim()) {
  console.error('\nREFUSED: source repository has uncommitted changes.');
  console.error('Nothing was discarded, reset, or cleaned.');
  console.error('Commit or stash these files, then retry. Isolation will not silently ignore local edits.\n');
  console.error(formatDirtyFiles(sourceInfo.status));
  process.exit(3);
}

const startedAt = Date.now();
const runId = makeRunId(args.task);
const dirs = runtimeDirs();
const runDir = path.join(dirs.runs, runId);
await mkdir(runDir, { recursive: true });

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
  }));

  let planText = '';
  let implementationText = '';
  let reviewText = '';
  let tests = { status: 'SKIP', reason: 'Not a modifying route', durationMs: 0, command: '', runner: '', exitCode: null };
  let finalDecision = 'SUCCESS';

  const codingPrompt = `Work on this repository task end-to-end: ${args.task}\nRead AGENTS.md if present. Make only relevant changes. Do not commit or push. Finish with a concise summary of changes. Independent tests will be run by the orchestrator.`;

  if (route.route === 'CURSOR') {
    result.implementation = 'FAIL';
    const out = await cursorAgent(repo, codingPrompt, args.cursorModel, false, cursorRunContext);
    await writeFile(path.join(runDir, 'implementation.txt'), out.text, 'utf8');
    result.implementation = 'PASS';
    result.implMs = out.proc.durationMs;
    timings.cursorMs += out.proc.durationMs;
    addStage('cursor-implementation', 'PASS', out.proc.durationMs);
    usageLog.push(workerUsage({ worker: 'cursor', model: args.cursorModel, durationMs: out.proc.durationMs, attempts: out.proc.attempts }));
    tests = await independentTests(repo, runDir);
  } else if (route.route === 'GEMINI') {
    result.review = 'FAIL';
    const out = await geminiReadOnly(repo, `You are the analysis/review agent for this repository. Read relevant repository files. Task: ${args.task}\nReturn a concise, actionable answer.`, runDir);
    await writeFile(path.join(runDir, 'review.txt'), out.text, 'utf8');
    result.review = 'PASS';
    result.reviewMs = out.proc.durationMs;
    timings.geminiMs += out.proc.durationMs;
    addStage('gemini-analysis', 'PASS', out.proc.durationMs);
    usageLog.push(workerUsage({ worker: 'gemini', model: 'antigravity', durationMs: out.proc.durationMs, attempts: out.proc.attempts, extra: { usage: out.usage } }));
    console.log('\n\nFINAL (Gemini/Antigravity):\n', out.text);
  } else if (route.route === 'CODEX') {
    result.implementation = 'FAIL';
    const out = await codex(repo, codingPrompt, args.windowsUnelevated);
    await writeFile(path.join(runDir, 'implementation.txt'), out.text, 'utf8');
    result.implementation = 'PASS';
    result.implMs = out.proc.durationMs;
    timings.codexMs += out.proc.durationMs;
    addStage('codex-implementation', 'PASS', out.proc.durationMs);
    usageLog.push(workerUsage({ worker: 'codex', model: 'codex', durationMs: out.proc.durationMs, attempts: out.proc.attempts }));
    tests = await independentTests(repo, runDir);
  } else {
    result.plan = 'FAIL';
    const plan = await cursorAgent(repo, `Act as a senior software architect. READ ONLY. Do NOT modify files. Create an implementation plan for this task: ${args.task}\nInclude risks, files likely affected, and verification steps. Keep it practical for another coding agent.`, args.cursorModel, true, cursorRunContext);
    planText = plan.text;
    await writeFile(path.join(runDir, 'plan.txt'), planText, 'utf8');
    result.plan = 'PASS';
    result.planMs = plan.proc.durationMs;
    timings.cursorMs += plan.proc.durationMs;
    addStage('cursor-plan', 'PASS', plan.proc.durationMs);
    usageLog.push(workerUsage({ worker: 'cursor', model: args.cursorModel, durationMs: plan.proc.durationMs, attempts: plan.proc.attempts }));

    result.implementation = 'FAIL';
    const implementation = await codex(repo, `Implement this task: ${args.task}\n\nA planning agent produced this plan:\n---\n${planText}\n---\nRead AGENTS.md if present. Validate the plan against the actual code. Make only relevant changes. Do not commit or push. Independent tests will be run by the orchestrator.`, args.windowsUnelevated);
    implementationText = implementation.text;
    await writeFile(path.join(runDir, 'implementation.txt'), implementationText, 'utf8');
    result.implementation = 'PASS';
    result.implMs = implementation.proc.durationMs;
    timings.codexMs += implementation.proc.durationMs;
    addStage('codex-implementation', 'PASS', implementation.proc.durationMs);
    usageLog.push(workerUsage({ worker: 'codex', model: 'codex', durationMs: implementation.proc.durationMs, attempts: implementation.proc.attempts }));

    tests = await independentTests(repo, runDir);
    timings.testsMs += tests.durationMs || 0;
    addStage('tests', tests.status, tests.durationMs || 0);

    let round = 0;
    let decision = 'UNKNOWN';
    for (;;) {
      if (tests.status === 'PASS' || tests.status === 'SKIP') {
        result.review = 'FAIL';
        const review = await geminiReadOnly(repo, `Act as a strict code reviewer. The task was: ${args.task}\nReview the CURRENT repository state and git changes. READ ONLY. DO NOT MODIFY FILES. Check correctness, security, missing tests, regressions, and scope creep.\nYour FIRST non-empty line MUST be exactly one of:\nPASS\nNEEDS_FIXES\nIf NEEDS_FIXES, follow it with concrete, actionable fixes. If PASS, briefly state why.`, runDir);
        reviewText = review.text;
        await writeFile(path.join(runDir, 'review.txt'), reviewText, 'utf8');
        decision = reviewDecision(reviewText);
        result.reviewMs = (result.reviewMs || 0) + review.proc.durationMs;
        timings.geminiMs += review.proc.durationMs;
        addStage(round === 0 ? 'gemini-review' : `gemini-review-${round}`, decision === 'PASS' ? 'PASS' : decision, review.proc.durationMs);
        usageLog.push(workerUsage({ worker: 'gemini', model: 'antigravity', durationMs: review.proc.durationMs, attempts: review.proc.attempts, extra: { usage: review.usage } }));
        console.log(`\n\nREVIEW DECISION: ${decision}\n`);
        if (decision === 'PASS') break;
      } else {
        decision = 'TESTS_FAIL';
      }

      if (round >= args.maxFixRounds) break;
      if (decision !== 'NEEDS_FIXES' && tests.status !== 'FAIL' && tests.status !== 'TIMEOUT') break;

      round += 1;
      console.log(`\n=== AUTO-FIX ROUND ${round}/${args.maxFixRounds} ===\n`);
      result.implementation = 'FAIL';
      const fixPrompt = [
        `The original task is: ${args.task}`,
        planText ? `\nPlan:\n---\n${planText}\n---` : '',
        `\nCurrent implementation context:\n---\n${implementationText}\n---`,
        tests.status === 'FAIL' || tests.status === 'TIMEOUT' ? `\nIndependent tests ${tests.status}. Command: ${tests.command}\nExit code: ${tests.exitCode}\nOutput:\n${tests.stdout}\n${tests.stderr}` : '',
        reviewText && decision === 'NEEDS_FIXES' ? `\nA strict reviewer found these issues:\n---\n${reviewText}\n---` : '',
        '\nFix ONLY the material issues. Do not commit or push.',
      ].join('\n');
      const fix = await codex(repo, fixPrompt, args.windowsUnelevated);
      implementationText = fix.text;
      await writeFile(path.join(runDir, `fix-round-${round}.txt`), fix.text, 'utf8');
      result.implementation = 'PASS';
      timings.codexMs += fix.proc.durationMs;
      addStage(`codex-fix-${round}`, 'PASS', fix.proc.durationMs);
      usageLog.push(workerUsage({ worker: 'codex', model: 'codex', durationMs: fix.proc.durationMs, attempts: fix.proc.attempts }));

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
  process.exit(1);
}
