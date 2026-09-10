import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, isInsideDir, pathsEqual, sourceFingerprint } from './workspace.mjs';
import {
  WorkspaceSafetyError,
  requireExplicitCwd,
  verifyRunWorkspace,
} from './workspace-context.mjs';

export const OWNED_TEMP_PREFIXES = Object.freeze(['ai-orch-gh-task-']);

export function assertBoundToRunWorkspace(cwd, allowedCwd, stage = 'worker') {
  const actual = requireExplicitCwd(cwd, stage);
  const allowed = requireExplicitCwd(allowedCwd, 'run-workspace');
  if (!pathsEqual(actual, allowed)) {
    throw new WorkspaceSafetyError(
      `SAFETY FAILURE: ${stage} cwd is not the current run workspace.\n${actual}\nexpected:\n${allowed}`,
    );
  }
  return actual;
}

export function assertNotForeignWorktree(cwd, { runId, worktreesRoot } = {}) {
  const actual = requireExplicitCwd(cwd, 'worker');
  if (!worktreesRoot || !runId) return actual;
  if (isInsideDir(worktreesRoot, actual) && path.basename(actual) !== String(runId)) {
    throw new WorkspaceSafetyError(
      `SAFETY FAILURE: worker attempted to use another run's worktree:\n${actual}`,
    );
  }
  return actual;
}

export async function recordHeadSha(repo, gitRunner = git) {
  const cwd = requireExplicitCwd(repo, 'record-head');
  try {
    return String(await gitRunner(cwd, ['rev-parse', 'HEAD']) || '').trim();
  } catch {
    return '';
  }
}

export function buildRunCheckpoint({
  runId = '',
  worktree = '',
  branch = '',
  headSha = '',
  lastStage = '',
  stages = [],
  updatedAt = new Date().toISOString(),
} = {}) {
  return {
    runId: String(runId || ''),
    worktree: worktree || '',
    branch: branch || '',
    headSha: String(headSha || ''),
    lastStage: lastStage || '',
    stages: Array.isArray(stages) ? stages : [],
    updatedAt,
  };
}

export async function writeRunCheckpoint(runDir, data) {
  const checkpoint = buildRunCheckpoint(data);
  await writeFile(path.join(runDir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2), 'utf8');
  return checkpoint;
}

export async function loadRunCheckpoint(runDir) {
  const raw = await readFile(path.join(runDir, 'checkpoint.json'), 'utf8');
  return JSON.parse(raw);
}

export async function resumeRunWorkspace(checkpoint, {
  worktreesRoot,
  sourceRoot = '',
  inPlace = false,
} = {}) {
  if (!checkpoint?.worktree) {
    throw new WorkspaceSafetyError('SAFETY FAILURE: checkpoint is missing a worktree path.');
  }
  if (!checkpoint.runId) {
    throw new WorkspaceSafetyError('SAFETY FAILURE: checkpoint is missing runId.');
  }
  return verifyRunWorkspace({
    workspace: checkpoint.worktree,
    runId: checkpoint.runId,
    expectedBranch: checkpoint.branch,
    createdByOrchestrator: true,
    sourceRoot,
    inPlace,
    worktreesRoot,
    stage: 'resume',
  });
}

export async function cleanupOwnedTempDir(dir, {
  tmpRoot = os.tmpdir(),
  prefixes = OWNED_TEMP_PREFIXES,
} = {}) {
  if (!dir) return { cleaned: false, reason: 'no path' };
  const resolved = path.resolve(dir);
  if (!isInsideDir(tmpRoot, resolved)) {
    return { cleaned: false, reason: 'outside temp root' };
  }
  const base = path.basename(resolved);
  if (!prefixes.some(prefix => base.startsWith(prefix))) {
    return { cleaned: false, reason: 'not an orchestrator temp directory' };
  }
  if (!existsSync(resolved)) return { cleaned: false, reason: 'missing' };
  await rm(resolved, { recursive: true, force: true });
  return { cleaned: true, reason: '' };
}

export function sourceRepoLeaked(startFingerprint, endInfo) {
  return sourceFingerprint(endInfo) !== startFingerprint;
}

export { pathsEqual };
