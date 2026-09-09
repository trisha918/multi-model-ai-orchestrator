import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createIsolatedWorktree, inspectSourceRepo, runtimeDirs, isInsideDir, sourceFingerprint, workingTreeChanged, gitState, removeOrchestratorWorktree, resolveTaskRepo, pathsEqual } from './workspace.mjs';
import { resolveTool } from './tooling.mjs';
import { packageRoot } from './paths.mjs';

function git(cwd, args) {
  const gitExe = resolveTool('git');
  const r = spawnSync(gitExe, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || `git ${args.join(' ')} failed`);
  return r.stdout.trim();
}

async function withRuntimeRoot(fn) {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-runtime-'));
  const prev = process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
  process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = runtime;
  try {
    return await fn(runtime);
  } finally {
    if (prev === undefined) delete process.env.AI_ORCHESTRATOR_RUNTIME_ROOT;
    else process.env.AI_ORCHESTRATOR_RUNTIME_ROOT = prev;
    await rm(runtime, { recursive: true, force: true });
  }
}

function initRepo(dir) {
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
}

test('inspectSourceRepo rejects non-git directories', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-nogit-'));
  try {
    await assert.rejects(() => inspectSourceRepo(dir), /not a Git repository/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isolated worktrees are unique and stay under orchestrator worktrees/', async () => {
  await withRuntimeRoot(async (runtime) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-src-'));
    const wtRoot = runtimeDirs().worktrees;
    try {
      initRepo(dir);
      await writeFile(path.join(dir, 'README.md'), 'hello\n', 'utf8');
      git(dir, ['add', '.']);
      git(dir, ['commit', '-m', 'init']);

      const a = await createIsolatedWorktree(dir, 'first task');
      const b = await createIsolatedWorktree(dir, 'second task');
      assert.notEqual(a.worktree, b.worktree);
      assert.notEqual(a.branch, b.branch);
      assert.ok(isInsideDir(wtRoot, a.worktree));
      assert.ok(isInsideDir(wtRoot, b.worktree));
      assert.ok(isInsideDir(runtime, a.worktree));
      assert.equal(git(dir, ['status', '--porcelain']), '');
      assert.equal(await inspectSourceRepo(dir).then(i => i.status), '');
      spawnSync(resolveTool('git'), ['worktree', 'remove', '--force', a.worktree], { cwd: dir, encoding: 'utf8' });
      spawnSync(resolveTool('git'), ['worktree', 'remove', '--force', b.worktree], { cwd: dir, encoding: 'utf8' });
    } finally {
      spawnSync(resolveTool('git'), ['worktree', 'prune'], { cwd: dir, encoding: 'utf8' });
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('source fingerprint detects unexpected workspace changes and ignores identical status', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-fp-'));
  try {
    initRepo(dir);
    await writeFile(path.join(dir, 'README.md'), 'hello\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'init']);
    const a = await inspectSourceRepo(dir);
    const b = await inspectSourceRepo(dir);
    assert.equal(sourceFingerprint(a), sourceFingerprint(b));
    await writeFile(path.join(dir, 'dirty.txt'), 'x', 'utf8');
    const c = await inspectSourceRepo(dir);
    assert.notEqual(sourceFingerprint(a), sourceFingerprint(c));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Gemini read-only change detection flags worktree diffs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gsafe-'));
  try {
    initRepo(dir);
    await writeFile(path.join(dir, 'README.md'), 'hello\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'init']);
    const before = await gitState(dir);
    assert.equal(workingTreeChanged(before, await gitState(dir)), false);
    await writeFile(path.join(dir, 'touched.txt'), 'gemini wrote this\n', 'utf8');
    const after = await gitState(dir);
    assert.equal(workingTreeChanged(before, after), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('successful worktree cleanup uses git worktree remove; failed path is preserved by policy', async () => {
  await withRuntimeRoot(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-rmwt-'));
    try {
      initRepo(dir);
      await writeFile(path.join(dir, 'README.md'), 'hello\n', 'utf8');
      git(dir, ['add', '.']);
      git(dir, ['commit', '-m', 'init']);
      const isolated = await createIsolatedWorktree(dir, 'cleanup task');
      const ok = await removeOrchestratorWorktree({
        sourceRepo: dir,
        worktree: isolated.worktree,
        runId: isolated.runId,
        createdByOrchestrator: true,
      });
      assert.equal(ok.removed, true, ok.reason);
      const denied = await removeOrchestratorWorktree({
        sourceRepo: dir,
        worktree: dir,
        runId: isolated.runId,
        createdByOrchestrator: true,
      });
      assert.equal(denied.removed, false);
    } finally {
      spawnSync(resolveTool('git'), ['worktree', 'prune'], { cwd: dir, encoding: 'utf8' });
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('resolveTaskRepo uses --repo when provided and cwd git root otherwise, never packageRoot', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-repo-'));
  try {
    initRepo(dir);
    await writeFile(path.join(dir, 'README.md'), 'hello\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'init']);
    const flagged = await resolveTaskRepo(dir, os.tmpdir());
    assert.equal(path.resolve(flagged), path.resolve(dir));
    const fromCwd = await resolveTaskRepo('', dir);
    assert.equal(path.resolve(fromCwd), path.resolve(dir));
    assert.notEqual(path.resolve(fromCwd), path.resolve(packageRoot()));
    await assert.rejects(() => resolveTaskRepo('', os.tmpdir()), /will not guess another repository/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two source repos isolate worktrees and do not leak dirty state', async () => {
  await withRuntimeRoot(async () => {
    const a = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-a-'));
    const b = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-b-'));
    try {
      for (const dir of [a, b]) {
        initRepo(dir);
        await writeFile(path.join(dir, 'README.md'), path.basename(dir), 'utf8');
        git(dir, ['add', '.']);
        git(dir, ['commit', '-m', 'init']);
      }
      const wa = await createIsolatedWorktree(a, 'work on a');
      const wb = await createIsolatedWorktree(b, 'work on b');
      assert.notEqual(wa.worktree, wb.worktree);
      assert.notEqual(wa.runId, wb.runId);
      assert.ok(pathsEqual(await inspectSourceRepo(a).then(i => i.root), a));
      assert.ok(pathsEqual(await inspectSourceRepo(b).then(i => i.root), b));
      assert.equal(git(a, ['status', '--porcelain']), '');
      assert.equal(git(b, ['status', '--porcelain']), '');
      spawnSync(resolveTool('git'), ['worktree', 'remove', '--force', wa.worktree], { cwd: a, encoding: 'utf8' });
      spawnSync(resolveTool('git'), ['worktree', 'remove', '--force', wb.worktree], { cwd: b, encoding: 'utf8' });
    } finally {
      spawnSync(resolveTool('git'), ['worktree', 'prune'], { cwd: a, encoding: 'utf8' });
      spawnSync(resolveTool('git'), ['worktree', 'prune'], { cwd: b, encoding: 'utf8' });
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });
});
