import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runTask } from './orchestrator.mjs';
import { writeModelsCache } from './model-cache.mjs';
import { emptyRegistry, finalizeRegistry } from './model-registry.mjs';
import { parseAgyModelsOutput, parseCursorModelsOutput } from './model-discovery.mjs';
import { runtimeDirs, createIsolatedWorktree, inspectSourceRepo, commitChanges } from './workspace.mjs';
import { WorkspaceSafetyError } from './workspace-context.mjs';
import { resolveTool } from './tooling.mjs';
import { DEFAULTS } from './config.mjs';
import {
  assertBoundToRunWorkspace,
  assertNotForeignWorktree,
  cleanupOwnedTempDir,
  loadRunCheckpoint,
  recordHeadSha,
  resumeRunWorkspace,
  writeRunCheckpoint,
} from './worker-isolation.mjs';

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
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function makeFailingExec({ failOn = '', dirtyCwd = false } = {}) {
  const calls = [];
  async function executeProcess(command, args, opts = {}) {
    calls.push({ command, args: [...(args || [])], cwd: opts.cwd });
    if (!opts.cwd) throw new Error('fake exec received no cwd');
    const kind = classifyWorker(command, args);
    if (dirtyCwd) {
      await writeFile(path.join(opts.cwd, `${kind}-dirty.txt`), `${kind} wrote this\n`, 'utf8');
    }
    if (kind === failOn) {
      const err = new Error(`${kind} process terminated`);
      err.stageStatus = 'FAIL';
      throw err;
    }
    if (kind === 'gemini') {
      return okProc(JSON.stringify({ status: 'SUCCESS', response: 'PASS\nlooks good' }));
    }
    return okProc(`${kind} ok`);
  }
  return { executeProcess, calls };
}

async function latestRunDir(runtime) {
  const runs = path.join(runtime, 'runs');
  const names = (await readdir(runs)).sort();
  assert.ok(names.length, 'expected a run directory');
  return path.join(runs, names[names.length - 1]);
}

test('a worker cannot bind to another run worktree', () => {
  const root = path.join(os.tmpdir(), 'worktrees');
  const mine = path.join(root, 'run-a');
  const theirs = path.join(root, 'run-b');
  assert.equal(assertBoundToRunWorkspace(mine, mine, 'codex'), path.resolve(mine));
  assert.throws(() => assertBoundToRunWorkspace(theirs, mine, 'codex'), WorkspaceSafetyError);
  assert.throws(
    () => assertNotForeignWorktree(theirs, { runId: 'run-a', worktreesRoot: root }),
    /another run's worktree/,
  );
  assert.equal(
    assertNotForeignWorktree(mine, { runId: 'run-a', worktreesRoot: root }),
    path.resolve(mine),
  );
});

test('owned temp dirs are cleaned; foreign dirs are refused', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-iso-tmp-'));
  const owned = await mkdtemp(path.join(tmpRoot, 'ai-orch-gh-task-'));
  const foreign = await mkdtemp(path.join(tmpRoot, 'not-ours-'));
  try {
    await writeFile(path.join(owned, 'task.txt'), 'secret task\n', 'utf8');
    const ok = await cleanupOwnedTempDir(owned, { tmpRoot });
    assert.equal(ok.cleaned, true);
    assert.equal(existsSync(owned), false);
    const denied = await cleanupOwnedTempDir(foreign, { tmpRoot });
    assert.equal(denied.cleaned, false);
    assert.equal(existsSync(foreign), true);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('commitChanges always records HEAD SHA, including no-op', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-sha-'));
  try {
    initRepo(dir);
    await writeFile(path.join(dir, 'README.md'), 'hello\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'init']);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const noop = await commitChanges(dir, 'nothing to do');
    assert.equal(noop.committed, false);
    assert.equal(noop.hash, head);
    await writeFile(path.join(dir, 'extra.txt'), 'work\n', 'utf8');
    const committed = await commitChanges(dir, 'add extra');
    assert.equal(committed.committed, true);
    assert.match(committed.hash, /^[0-9a-f]{40}$/i);
    assert.notEqual(committed.hash, head);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dirtying one isolated worktree does not leak into a sibling or the source repo', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-sib-'));
  const prev = process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
  process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = runtime;
  const source = await makeSourceRepo('ai-orch-sibsrc-');
  try {
    const a = await createIsolatedWorktree(source, 'task a');
    const b = await createIsolatedWorktree(source, 'task b');
    await writeFile(path.join(a.worktree, 'only-a.txt'), 'a\n', 'utf8');
    assert.equal(existsSync(path.join(b.worktree, 'only-a.txt')), false);
    assert.equal(git(source, ['status', '--porcelain']), '');
    assert.equal((await inspectSourceRepo(source)).status, '');
    assert.notEqual(a.worktree, b.worktree);
    spawnSync(resolveTool('git'), ['worktree', 'remove', '--force', a.worktree], { cwd: source, encoding: 'utf8' });
    spawnSync(resolveTool('git'), ['worktree', 'remove', '--force', b.worktree], { cwd: source, encoding: 'utf8' });
  } finally {
    if (prev === undefined) delete process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
    else process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = prev;
    spawnSync(resolveTool('git'), ['worktree', 'prune'], { cwd: source, encoding: 'utf8' });
    await rm(source, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test('failed Codex worker leaves source clean, records SHA, and resume can re-pin the worktree', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-kill-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-killcfg-'));
  const source = await makeSourceRepo('ai-orch-killsrc-');
  const prevRuntime = process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
  process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = runtime;
  const env = {
    ...process.env,
    AI_ORCHESTRATOR_RUNTIME_ROOT: runtime,
    AI_ORCHESTRATOR_CONFIG_DIR: configDir,
  };
  await seedModelsCache(env);
  const fake = makeFailingExec({ failOn: 'codex', dirtyCwd: true });
  const prevExit = process.exitCode;
  try {
    const code = await runTask(
      ['--mode', 'team', '--repo', source, '--task', 'Add subtract and tests.'],
      {
        env,
        config: { ...DEFAULTS, workerMaxRetries: 0, keepFailedWorktrees: true },
        executeProcess: fake.executeProcess,
      },
    );
    assert.notEqual(code, 0);
    assert.equal(git(source, ['status', '--porcelain']), '');
    const runDir = await latestRunDir(runtime);
    const checkpoint = await loadRunCheckpoint(runDir);
    const meta = JSON.parse(await readFile(path.join(runDir, 'meta.json'), 'utf8'));
    assert.ok(checkpoint.worktree);
    assert.ok(existsSync(checkpoint.worktree));
    assert.match(checkpoint.headSha, /^[0-9a-f]{40}$/i);
    assert.equal(meta.headSha, checkpoint.headSha);
    assert.match(String(meta.commitHash || ''), /^[0-9a-f]{40}$/i);
    assert.ok(existsSync(path.join(checkpoint.worktree, 'codex-dirty.txt')));
    assert.equal(existsSync(path.join(source, 'codex-dirty.txt')), false);
    const resumed = await resumeRunWorkspace(checkpoint, {
      worktreesRoot: runtimeDirs(env).worktrees,
      sourceRoot: source,
    });
    assert.equal(path.resolve(resumed.cwd), path.resolve(checkpoint.worktree));
    assert.equal(await recordHeadSha(checkpoint.worktree), checkpoint.headSha);
  } finally {
    process.exitCode = prevExit;
    if (prevRuntime === undefined) delete process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
    else process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = prevRuntime;
    await rm(runtime, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test('Gemini write during review is a safety failure and does not dirty the source repo', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gem-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gemcfg-'));
  const source = await makeSourceRepo('ai-orch-gemsrc-');
  const prevRuntime = process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
  process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = runtime;
  const env = {
    ...process.env,
    AI_ORCHESTRATOR_RUNTIME_ROOT: runtime,
    AI_ORCHESTRATOR_CONFIG_DIR: configDir,
  };
  await seedModelsCache(env);
  const fake = makeFailingExec({ dirtyCwd: true });
  const originalGemini = fake.executeProcess;
  fake.executeProcess = async (command, args, opts = {}) => {
    const kind = classifyWorker(command, args);
    if (kind === 'gemini') {
      await writeFile(path.join(opts.cwd, 'gemini-dirty.txt'), 'reviewer wrote\n', 'utf8');
      return okProc(JSON.stringify({ status: 'SUCCESS', response: 'PASS\nok' }));
    }
    return originalGemini(command, args, opts);
  };
  const prevExit = process.exitCode;
  try {
    const code = await runTask(
      ['--mode', 'team', '--repo', source, '--task', 'Add subtract and tests.'],
      {
        env,
        config: { ...DEFAULTS, workerMaxRetries: 0, keepFailedWorktrees: true },
        executeProcess: fake.executeProcess,
      },
    );
    assert.notEqual(code, 0);
    assert.equal(git(source, ['status', '--porcelain']), '');
    const runDir = await latestRunDir(runtime);
    const error = await readFile(path.join(runDir, 'error.txt'), 'utf8');
    assert.match(error, /SAFETY VIOLATION|Gemini\/Antigravity modified/);
    const checkpoint = await loadRunCheckpoint(runDir);
    assert.ok(existsSync(checkpoint.worktree));
    const resumed = await resumeRunWorkspace(checkpoint, {
      worktreesRoot: runtimeDirs(env).worktrees,
      sourceRoot: source,
    });
    assert.equal(path.resolve(resumed.cwd), path.resolve(checkpoint.worktree));
  } finally {
    process.exitCode = prevExit;
    if (prevRuntime === undefined) delete process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
    else process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = prevRuntime;
    await rm(runtime, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test('resume rejects a checkpoint that points at a sibling worktree', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-badck-'));
  try {
    await mkdir(path.join(runtime, 'worktrees', 'run-a'), { recursive: true });
    const checkpoint = await writeRunCheckpoint(runtime, {
      runId: 'run-a',
      worktree: path.join(runtime, 'worktrees', 'run-b'),
      branch: 'ai/task',
      headSha: 'abc',
    });
    await assert.rejects(
      () => resumeRunWorkspace(checkpoint, { worktreesRoot: path.join(runtime, 'worktrees') }),
      /SAFETY FAILURE/,
    );
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
});
