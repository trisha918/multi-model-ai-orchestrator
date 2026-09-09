import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTask } from './orchestrator.mjs';
import { writeModelsCache } from './model-cache.mjs';
import { emptyRegistry, finalizeRegistry } from './model-registry.mjs';
import { parseAgyModelsOutput, parseCursorModelsOutput } from './model-discovery.mjs';
import { packageRoot } from './paths.mjs';
import { runtimeDirs } from './workspace.mjs';
import { resolveTool } from './tooling.mjs';
import { DEFAULTS } from './config.mjs';
import {
  WorkspaceSafetyError,
  buildAntigravityArgs,
  buildCodexCliArgs,
  requireExplicitCwd,
  verifyRunWorkspace,
  workspaceTraceRecord,
} from './workspace-context.mjs';
import { buildGeminiReviewPrompt } from './prompts.mjs';

function git(cwd, args) {
  const r = spawnSync(resolveTool('git'), args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || `git ${args.join(' ')} failed`);
  return r.stdout.trim();
}

function initRepo(dir) {
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
}

function okProc(stdout = '') {
  return {
    exitCode: 0,
    timedOut: false,
    stdout,
    stderr: '',
    durationMs: 1,
    attempts: 1,
  };
}

function classifyWorker(command, args) {
  const joined = [command, ...(args || [])].join(' ');
  if ((args || []).includes('--add-dir') || (args || []).includes('--new-project')) return 'gemini';
  if ((args || []).includes('--workspace') || (args || []).includes('--mode=ask')) return 'cursor';
  if ((args || []).includes('-C') && (args || []).includes('exec')) return 'codex';
  if (/\bnpm(\.cmd)?\b/i.test(String(command)) || (args || []).includes('test')) return 'tests';
  return `other:${joined.slice(0, 80)}`;
}

function argAfter(args, flag) {
  const i = (args || []).indexOf(flag);
  return i >= 0 ? args[i + 1] : '';
}

async function seedModelsCache(env) {
  const registry = emptyRegistry(new Date().toISOString());
  registry.providers.cursor = {
    status: 'ok',
    source: 'test',
    lastChecked: new Date().toISOString(),
    models: parseCursorModelsOutput('auto - Auto\n'),
  };
  registry.providers.codex = {
    status: 'ok',
    source: 'test',
    lastChecked: new Date().toISOString(),
    models: [{
      provider: 'codex',
      id: 'gpt-5.6-terra',
      displayName: 'Terra',
      aliases: ['terra'],
      available: true,
      source: 'test',
      lastChecked: new Date().toISOString(),
    }],
  };
  registry.providers.gemini = {
    status: 'ok',
    source: 'test',
    lastChecked: new Date().toISOString(),
    models: parseAgyModelsOutput('gemini-3.8-flash-high\tFlash High\n'),
  };
  await writeModelsCache(finalizeRegistry(registry), env);
}

async function makeSourceRepo(label) {
  const dir = await mkdtemp(path.join(os.tmpdir(), label));
  initRepo(dir);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'calc-fixture',
    scripts: { test: 'node -e "process.exit(0)"' },
  }), 'utf8');
  await writeFile(path.join(dir, 'calculator.js'), 'export function add(a, b) { return a + b; }\n', 'utf8');
  await writeFile(path.join(dir, 'calculator.test.js'), 'import { add } from "./calculator.js"; if (add(1,2) !== 3) process.exit(1);\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function makeFakeExec({ geminiBodies } = {}) {
  const calls = [];
  let geminiCount = 0;
  const bodies = geminiBodies || ['PASS\nlooks good'];
  async function executeProcess(command, args, opts = {}) {
    calls.push({ command, args: [...(args || [])], cwd: opts.cwd });
    if (!opts.cwd) {
      throw new Error('fake exec received no cwd');
    }
    const kind = classifyWorker(command, args);
    if (kind === 'gemini') {
      const body = bodies[Math.min(geminiCount, bodies.length - 1)];
      geminiCount += 1;
      return okProc(JSON.stringify({ status: 'SUCCESS', response: body }));
    }
    if (kind === 'cursor') return okProc('Plan: add subtract in calculator.js');
    if (kind === 'codex') return okProc('Implemented subtract');
    if (kind === 'tests') return okProc('ok');
    return okProc('');
  }
  return { executeProcess, calls, geminiCount: () => geminiCount };
}

async function latestRunDir(runtime) {
  const runs = path.join(runtime, 'runs');
  const names = (await readdir(runs)).sort();
  assert.ok(names.length, 'expected a run directory');
  return path.join(runs, names[names.length - 1]);
}

test('requireExplicitCwd rejects inherited empty cwd', () => {
  assert.throws(() => requireExplicitCwd('', 'gemini'), WorkspaceSafetyError);
  assert.throws(() => requireExplicitCwd(undefined, 'gemini'), /SAFETY FAILURE/);
  const cwd = requireExplicitCwd(path.join(os.tmpdir(), 'wt'), 'gemini');
  assert.equal(path.isAbsolute(cwd), true);
});

test('buildAntigravityArgs pins --add-dir/--new-project and refuses missing cwd', () => {
  const wt = path.join(os.tmpdir(), 'isolated-wt');
  const launch = buildAntigravityArgs({ prompt: 'review', model: 'gemini-x', cwd: wt, timeoutArg: '5m' });
  assert.equal(launch.cwd, path.resolve(wt));
  assert.ok(launch.args.includes('--add-dir'));
  assert.equal(argAfter(launch.args, '--add-dir'), launch.cwd);
  assert.ok(launch.args.includes('--new-project'));
  assert.ok(launch.args.includes('--sandbox'));
  assert.ok(!launch.args.includes('--yolo'));
  assert.throws(() => buildAntigravityArgs({ prompt: 'x', cwd: '' }), /SAFETY FAILURE/);
});

test('buildCodexCliArgs uses -C worktree distinct from sandbox -c', () => {
  const wt = path.join(os.tmpdir(), 'codex wt');
  const launch = buildCodexCliArgs({ windowsUnelevated: true, model: 'gpt-5.6-terra', cwd: wt, isWin: true });
  assert.equal(launch.args[0], '-C');
  assert.equal(launch.args[1], launch.cwd);
  const sandboxIdx = launch.args.indexOf('-c');
  assert.ok(sandboxIdx > 1);
  assert.equal(launch.args[sandboxIdx + 1], 'windows.sandbox="unelevated"');
  assert.ok(launch.args.includes('-m'));
});

test('review prompt names the verified worktree and does not ask Gemini to discover a repo', () => {
  const wt = 'F:\\runs\\worktrees\\20260101T000000Z-task-abc';
  const prompt = buildGeminiReviewPrompt({
    task: 'Add subtract',
    worktree: wt,
    planText: 'Add subtract(a,b)',
    testsSummary: 'status=PASS',
    gitDiff: '### git diff\n+export function subtract',
  });
  assert.match(prompt, /You are reviewing the repository located at:/);
  assert.ok(prompt.includes(wt));
  assert.match(prompt, /Review ONLY the current isolated worktree/);
  assert.match(prompt, /Do not inspect or modify the source workspace/);
  assert.match(prompt, /Original task:/);
  assert.match(prompt, /Cursor plan:/);
  assert.match(prompt, /Independent test result:/);
  assert.match(prompt, /Current git status\/diff from that worktree:/);
});

test('verifyRunWorkspace enforces current-run identity', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-id-'));
  const worktreesRoot = path.join(runtime, 'worktrees');
  const runId = '20260909T000000Z-task-abc123';
  const worktree = path.join(worktreesRoot, runId);
  await mkdir(worktree, { recursive: true });
  const sourceRoot = path.join(runtime, 'source');
  await mkdir(sourceRoot);
  try {
    await assert.rejects(
      () => verifyRunWorkspace({
        workspace: sourceRoot,
        runId,
        createdByOrchestrator: true,
        sourceRoot,
        worktreesRoot,
        stage: 'gemini-review',
        gitRunner: async () => sourceRoot,
      }),
      /SAFETY FAILURE/,
    );
    await assert.rejects(
      () => verifyRunWorkspace({
        workspace: path.join(worktreesRoot, 'other-run'),
        runId,
        createdByOrchestrator: true,
        sourceRoot,
        worktreesRoot,
        stage: 'gemini-review',
        gitRunner: async () => worktreesRoot,
      }),
      /SAFETY FAILURE/,
    );
    const ok = await verifyRunWorkspace({
      workspace: worktree,
      runId,
      expectedBranch: 'ai/demo',
      createdByOrchestrator: true,
      sourceRoot,
      worktreesRoot,
      stage: 'gemini-review',
      gitRunner: async (cwd, args) => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd;
        if (args.includes('--abbrev-ref')) return 'ai/demo';
        return '';
      },
    });
    assert.equal(ok.cwd, path.resolve(worktree));
    assert.equal(ok.branch, 'ai/demo');
    assert.equal(ok.runId, runId);
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
});

test('TEAM fake workers pin the same worktree and never inherit orchestrator cwd', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'ai orch rt '));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'ai orch cfg '));
  const source = await makeSourceRepo('ai orch src ');
  const prevRuntime = process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
  const prevCwd = process.cwd();
  process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = runtime;
  const env = {
    ...process.env,
    AI_ORCHESTRATOR_RUNTIME_ROOT: runtime,
    AI_ORCHESTRATOR_CONFIG_DIR: configDir,
  };
  await seedModelsCache(env);
  const fake = makeFakeExec();
  try {
    process.chdir(packageRoot());
    const code = await runTask(
      ['--mode', 'team', '--repo', source, '--task', 'Add a subtract(a, b) function and a matching test. Do not change add().'],
      {
        env,
        config: { ...DEFAULTS, workerMaxRetries: 0 },
        executeProcess: fake.executeProcess,
      },
    );
    assert.equal(code, undefined);
    const kinds = fake.calls.map(c => classifyWorker(c.command, c.args));
    assert.ok(kinds.includes('cursor'));
    assert.ok(kinds.includes('codex'));
    assert.ok(kinds.includes('tests'));
    assert.ok(kinds.includes('gemini'));
    const workerCalls = fake.calls.filter(c => ['cursor', 'codex', 'gemini', 'tests'].includes(classifyWorker(c.command, c.args)));
    const cwds = [...new Set(workerCalls.map(c => path.resolve(c.cwd)))];
    assert.equal(cwds.length, 1, `mixed cwds: ${cwds.join(' | ')}`);
    const wt = cwds[0];
    assert.notEqual(path.resolve(wt), path.resolve(source));
    assert.notEqual(path.resolve(wt), packageRoot());
    assert.notEqual(path.resolve(wt), path.resolve(prevCwd));
    assert.equal(path.basename(path.dirname(wt)), 'worktrees');
    const gemini = fake.calls.filter(c => classifyWorker(c.command, c.args) === 'gemini');
    assert.equal(gemini.length, 1);
    assert.equal(path.resolve(gemini[0].cwd), wt);
    assert.equal(argAfter(gemini[0].args, '--add-dir'), path.resolve(gemini[0].cwd));
    assert.ok(gemini[0].args.includes('--new-project'));
    const prompt = argAfter(gemini[0].args, '-p');
    assert.ok(prompt.includes(wt) || prompt.includes(path.resolve(wt)));
    assert.match(prompt, /Review ONLY the current isolated worktree/);
    assert.ok(!gemini[0].args.includes('--yolo'));
    const cursor = fake.calls.find(c => classifyWorker(c.command, c.args) === 'cursor');
    assert.equal(argAfter(cursor.args, '--workspace'), path.resolve(cursor.cwd));
    const codex = fake.calls.find(c => classifyWorker(c.command, c.args) === 'codex');
    assert.equal(argAfter(codex.args, '-C'), path.resolve(codex.cwd));
    const runDir = await latestRunDir(runtime);
    const trace = JSON.parse(await readFile(path.join(runDir, 'workspace-trace.json'), 'utf8'));
    const stages = JSON.parse(await readFile(path.join(runDir, 'stages.json'), 'utf8'));
    assert.ok(trace.every(t => path.resolve(t.cwd) === wt));
    assert.ok(trace.some(t => t.stage === 'gemini-review'));
    assert.ok(trace.every(t => t.matchesSource === false));
    assert.ok(stages.find(s => s.name === 'gemini-review')?.cwd);
    const summary = await readFile(path.join(runDir, 'meta.json'), 'utf8');
    assert.ok(summary);
  } finally {
    process.chdir(prevCwd);
    if (prevRuntime === undefined) delete process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
    else process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = prevRuntime;
    await rm(runtime, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test('TEAM fix loop keeps Codex, tests, and Gemini re-review on the same worktree', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-fix-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-fixcfg-'));
  const source = await makeSourceRepo('ai-orch-fixsrc-');
  const prevRuntime = process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
  process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = runtime;
  const env = {
    ...process.env,
    AI_ORCHESTRATOR_RUNTIME_ROOT: runtime,
    AI_ORCHESTRATOR_CONFIG_DIR: configDir,
  };
  await seedModelsCache(env);
  const fake = makeFakeExec({ geminiBodies: ['NEEDS_FIXES\nadd a clarifying comment', 'PASS\nfixed'] });
  try {
    await runTask(
      ['--mode', 'team', '--repo', source, '--task', 'Add subtract(a, b) and tests.', '--max-fix-rounds', '2'],
      {
        env,
        config: { ...DEFAULTS, workerMaxRetries: 0 },
        executeProcess: fake.executeProcess,
      },
    );
    const gemini = fake.calls.filter(c => classifyWorker(c.command, c.args) === 'gemini');
    const codex = fake.calls.filter(c => classifyWorker(c.command, c.args) === 'codex');
    const tests = fake.calls.filter(c => classifyWorker(c.command, c.args) === 'tests');
    assert.equal(gemini.length, 2);
    assert.equal(codex.length, 2);
    assert.equal(tests.length, 2);
    const wt = path.resolve(gemini[0].cwd);
    for (const c of [...gemini, ...codex, ...tests]) {
      assert.equal(path.resolve(c.cwd), wt);
    }
    const runDir = await latestRunDir(runtime);
    const trace = JSON.parse(await readFile(path.join(runDir, 'workspace-trace.json'), 'utf8'));
    assert.ok(trace.some(t => t.stage === 'codex-fix-1'));
    assert.ok(trace.some(t => t.stage === 'gemini-review-1'));
    assert.ok(trace.every(t => path.resolve(t.cwd) === wt));
    const rec = workspaceTraceRecord(trace[0]);
    assert.equal('secret' in rec, false);
  } finally {
    if (prevRuntime === undefined) delete process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
    else process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = prevRuntime;
    await rm(runtime, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test('sequential TEAM runs cannot mix worktree paths', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-mix-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-mixcfg-'));
  const a = await makeSourceRepo('ai-orch-a-');
  const b = await makeSourceRepo('ai-orch-b-');
  const prevRuntime = process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
  process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = runtime;
  const env = {
    ...process.env,
    AI_ORCHESTRATOR_RUNTIME_ROOT: runtime,
    AI_ORCHESTRATOR_CONFIG_DIR: configDir,
  };
  await seedModelsCache(env);
  const fakeA = makeFakeExec();
  const fakeB = makeFakeExec();
  try {
    await runTask(['--mode', 'team', '--repo', a, '--task', 'Add subtract for project A.'], {
      env, config: { ...DEFAULTS, workerMaxRetries: 0 }, executeProcess: fakeA.executeProcess,
    });
    await runTask(['--mode', 'team', '--repo', b, '--task', 'Add subtract for project B.'], {
      env, config: { ...DEFAULTS, workerMaxRetries: 0 }, executeProcess: fakeB.executeProcess,
    });
    const wtA = path.resolve(fakeA.calls.find(c => classifyWorker(c.command, c.args) === 'gemini').cwd);
    const wtB = path.resolve(fakeB.calls.find(c => classifyWorker(c.command, c.args) === 'gemini').cwd);
    assert.notEqual(wtA, wtB);
    assert.ok(fakeA.calls.every(c => !c.cwd || path.resolve(c.cwd) !== wtB));
    assert.ok(fakeB.calls.every(c => !c.cwd || path.resolve(c.cwd) !== wtA));
    assert.ok(wtA.includes('worktrees'));
    assert.ok(wtB.includes('worktrees'));
  } finally {
    if (prevRuntime === undefined) delete process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
    else process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = prevRuntime;
    await rm(runtime, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test('CURSOR and CODEX routes also use explicit current worktree cwd', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-solo-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-solocfg-'));
  const source = await makeSourceRepo('ai-orch-solosrc-');
  const prevRuntime = process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
  process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = runtime;
  const env = {
    ...process.env,
    AI_ORCHESTRATOR_RUNTIME_ROOT: runtime,
    AI_ORCHESTRATOR_CONFIG_DIR: configDir,
  };
  await seedModelsCache(env);
  try {
    const cursorFake = makeFakeExec();
    await runTask(['--mode', 'cursor', '--repo', source, '--task', 'Rename a local comment.'], {
      env, config: { ...DEFAULTS, workerMaxRetries: 0 }, executeProcess: cursorFake.executeProcess,
    });
    const cursorWt = path.resolve(cursorFake.calls.find(c => classifyWorker(c.command, c.args) === 'cursor').cwd);
    const cursorTests = cursorFake.calls.find(c => classifyWorker(c.command, c.args) === 'tests');
    assert.equal(path.resolve(cursorTests.cwd), cursorWt);

    const runtime2 = runtimeDirs(env).worktrees;
    const leftover = (await readdir(runtime2).catch(() => []));
    void leftover;

    const codexFake = makeFakeExec();
    await runTask(['--mode', 'codex', '--repo', source, '--task', 'Fix a tiny bug in calculator.js'], {
      env, config: { ...DEFAULTS, workerMaxRetries: 0 }, executeProcess: codexFake.executeProcess,
    });
    const impl = codexFake.calls.find(c => classifyWorker(c.command, c.args) === 'codex');
    const tests = codexFake.calls.find(c => classifyWorker(c.command, c.args) === 'tests');
    assert.equal(path.resolve(impl.cwd), path.resolve(tests.cwd));
    assert.notEqual(path.resolve(impl.cwd), path.resolve(source));
  } finally {
    if (prevRuntime === undefined) delete process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
    else process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = prevRuntime;
    await rm(runtime, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});
