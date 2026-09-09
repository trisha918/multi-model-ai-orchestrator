import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  canonicalPath,
  git,
  isInsideDir,
  pathsEqual,
  runtimeDirs,
  shouldTrustCursorWorkspace,
} from './workspace.mjs';
import { packageRoot } from './paths.mjs';

export class WorkspaceSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceSafetyError';
    this.stageStatus = 'SAFETY';
  }
}

export function requireExplicitCwd(cwd, label = 'worker') {
  const value = String(cwd || '').trim();
  if (!value) {
    throw new WorkspaceSafetyError(`SAFETY FAILURE: ${label} is missing an explicit cwd. Inherited process.cwd() is not allowed.`);
  }
  return path.resolve(value);
}

export function cwdIsNotOrchestratorClone(cwd) {
  return !pathsEqual(cwd, packageRoot());
}

export async function inspectWorkspaceGit(workspace, gitRunner = git) {
  const cwd = path.resolve(workspace);
  const toplevel = path.resolve(await gitRunner(cwd, ['rev-parse', '--show-toplevel']));
  const branch = await gitRunner(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { gitRoot: toplevel, branch };
}

export async function verifyRunWorkspace({
  workspace,
  runId,
  expectedBranch = '',
  createdByOrchestrator = false,
  sourceRoot = '',
  inPlace = false,
  worktreesRoot,
  gitRunner = git,
  stage = 'worker',
} = {}) {
  const cwd = requireExplicitCwd(workspace, stage);
  if (!existsSync(cwd)) {
    throw new WorkspaceSafetyError(`SAFETY FAILURE: workspace does not exist:\n${cwd}`);
  }
  try {
    if (!statSync(cwd).isDirectory()) {
      throw new WorkspaceSafetyError(`SAFETY FAILURE: workspace is not a directory:\n${cwd}`);
    }
  } catch (e) {
    if (e instanceof WorkspaceSafetyError) throw e;
    throw new WorkspaceSafetyError(`SAFETY FAILURE: cannot stat workspace:\n${cwd}`);
  }

  if (!inPlace) {
    const wtRoot = worktreesRoot || runtimeDirs().worktrees;
    if (!shouldTrustCursorWorkspace(cwd, { runId, createdByOrchestrator, worktreesRoot: wtRoot })) {
      throw new WorkspaceSafetyError(`SAFETY FAILURE: ${stage} cwd is not the current isolated worktree for run ${runId}.\n${cwd}`);
    }
    if (path.basename(cwd) !== String(runId)) {
      throw new WorkspaceSafetyError(`SAFETY FAILURE: worktree folder does not belong to run ${runId}:\n${cwd}`);
    }
    if (!isInsideDir(wtRoot, cwd)) {
      throw new WorkspaceSafetyError(`SAFETY FAILURE: worktree is outside the managed worktrees root:\n${cwd}`);
    }
  }

  if (sourceRoot && pathsEqual(cwd, sourceRoot) && !inPlace) {
    throw new WorkspaceSafetyError(`SAFETY FAILURE: ${stage} would run in the source workspace instead of the isolated worktree.`);
  }
  if (!cwdIsNotOrchestratorClone(cwd) && sourceRoot && !pathsEqual(sourceRoot, packageRoot())) {
    throw new WorkspaceSafetyError(`SAFETY FAILURE: ${stage} cwd is the orchestrator clone:\n${cwd}`);
  }

  let gitInfo;
  try {
    gitInfo = await inspectWorkspaceGit(cwd, gitRunner);
  } catch (e) {
    throw new WorkspaceSafetyError(`SAFETY FAILURE: git identity check failed for ${stage} at ${cwd}\n${e instanceof Error ? e.message : String(e)}`);
  }

  if (!pathsEqual(gitInfo.gitRoot, cwd)) {
    throw new WorkspaceSafetyError(`SAFETY FAILURE: git --show-toplevel (${gitInfo.gitRoot}) does not match the intended worktree:\n${cwd}`);
  }
  if (expectedBranch && gitInfo.branch && gitInfo.branch !== 'HEAD' && gitInfo.branch !== expectedBranch) {
    throw new WorkspaceSafetyError(`SAFETY FAILURE: worktree branch is ${gitInfo.branch}, expected ${expectedBranch}`);
  }

  return {
    cwd,
    gitRoot: gitInfo.gitRoot,
    branch: gitInfo.branch,
    runId: String(runId || ''),
    stage,
  };
}

export function buildAntigravityArgs({ prompt, model = '', cwd, timeoutArg }) {
  const workspace = requireExplicitCwd(cwd, 'gemini');
  const args = ['-p', prompt];
  if (model) args.push('--model', model);
  args.push('--add-dir', workspace, '--new-project');
  args.push(
    '--output-format', 'json',
    '--print-timeout', timeoutArg,
    '--mode', 'plan',
    '--sandbox',
    '--dangerously-skip-permissions',
  );
  return { cwd: workspace, args };
}

export function buildCodexCliArgs({ windowsUnelevated = false, model = '', cwd, isWin = false }) {
  const workspace = requireExplicitCwd(cwd, 'codex');
  const args = [];
  args.push('-C', workspace);
  if (isWin && windowsUnelevated) args.push('-c', 'windows.sandbox="unelevated"');
  if (model) args.push('-m', model);
  args.push('--ask-for-approval', 'never', 'exec', '--sandbox', 'workspace-write', '-');
  return { cwd: workspace, args };
}

export function workspaceTraceRecord({ stage, cwd, gitRoot, branch, runId, sourceRoot = '' }) {
  return {
    stage,
    cwd,
    gitRoot,
    branch,
    runId,
    matchesSource: sourceRoot ? pathsEqual(cwd, sourceRoot) : false,
  };
}

export { canonicalPath, pathsEqual };
