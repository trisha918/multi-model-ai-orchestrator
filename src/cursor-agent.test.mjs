import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { shouldTrustCursorWorkspace } from './workspace.mjs';
import { buildCursorAgentArgs } from './cursor-agent.mjs';

test('verified orchestrator worktree gets --trust', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-trust-'));
  const worktreesRoot = path.join(root, 'worktrees');
  const runId = '20260908T000000Z-task-abc123';
  const worktree = path.join(worktreesRoot, runId);
  await mkdir(worktree, { recursive: true });
  try {
    assert.equal(shouldTrustCursorWorkspace(worktree, {
      runId,
      createdByOrchestrator: true,
      worktreesRoot,
    }), true);
    const args = buildCursorAgentArgs({
      prompt: 'line1\nline2',
      model: 'auto',
      readOnly: false,
      trust: true,
    });
    assert.deepEqual(args, ['--trust', '--model', 'auto', '--output-format', 'text', '-p', 'line1\nline2']);
    assert.ok(args.indexOf('--trust') < args.indexOf('-p'));
    assert.ok(!args.includes('--yolo'));
    assert.ok(!args.includes('-f'));
    const special = buildCursorAgentArgs({
      prompt: 'Fix this! Do not break it.',
      trust: true,
    });
    assert.equal(special[special.length - 1], 'Fix this! Do not break it.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('arbitrary external directory does not get automatic --trust', async () => {
  const external = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-external-'));
  const worktreesRoot = path.join(external, 'worktrees');
  await mkdir(worktreesRoot, { recursive: true });
  try {
    assert.equal(shouldTrustCursorWorkspace(external, {
      runId: 'run-1',
      createdByOrchestrator: true,
      worktreesRoot,
    }), false);
    assert.equal(shouldTrustCursorWorkspace(external, {
      runId: 'run-1',
      createdByOrchestrator: false,
      worktreesRoot,
    }), false);
    const args = buildCursorAgentArgs({
      prompt: 'hello',
      trust: false,
    });
    assert.ok(!args.includes('--trust'));
  } finally {
    await rm(external, { recursive: true, force: true });
  }
});

test('path traversal and similar-prefix siblings are not trusted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-escape-'));
  const worktreesRoot = path.join(root, 'worktrees');
  const runId = 'run-safe';
  const worktree = path.join(worktreesRoot, runId);
  const siblingPrefix = path.join(root, 'worktrees-evil', runId);
  await mkdir(worktree, { recursive: true });
  await mkdir(siblingPrefix, { recursive: true });
  await writeFile(path.join(root, 'secret.txt'), 'nope', 'utf8');
  try {
    const traversal = path.join(worktree, '..', '..', 'secret.txt');
    assert.equal(shouldTrustCursorWorkspace(traversal, {
      runId,
      createdByOrchestrator: true,
      worktreesRoot,
    }), false);

    const viaDotDot = path.join(worktreesRoot, runId, '..', '..', 'worktrees-evil', runId);
    assert.equal(shouldTrustCursorWorkspace(viaDotDot, {
      runId,
      createdByOrchestrator: true,
      worktreesRoot,
    }), false);

    assert.equal(shouldTrustCursorWorkspace(siblingPrefix, {
      runId,
      createdByOrchestrator: true,
      worktreesRoot,
    }), false);

    const otherRun = path.join(worktreesRoot, 'someone-elses-run');
    await mkdir(otherRun);
    assert.equal(shouldTrustCursorWorkspace(otherRun, {
      runId,
      createdByOrchestrator: true,
      worktreesRoot,
    }), false);

    assert.equal(shouldTrustCursorWorkspace(worktree, {
      runId: `${runId}/../${runId}`,
      createdByOrchestrator: true,
      worktreesRoot,
    }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
