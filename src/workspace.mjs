import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isWin, runTool } from './tooling.mjs';
import { runtimeDirs } from './paths.mjs';

export { runtimeDirs };

const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

export function canonicalPath(input) {
  const resolved = path.resolve(String(input || ''));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function normalizeForCompare(p) {
  const n = canonicalPath(p);
  return isWin ? n.replace(/\//g, '\\').toLowerCase() : n;
}

export function pathsEqual(a, b) {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

export function isInsideDir(parent, child) {
  const parentC = canonicalPath(parent);
  const childC = canonicalPath(child);
  const rel = path.relative(parentC, childC);
  if (!rel || path.isAbsolute(rel)) return false;
  const relCmp = isWin ? rel.replace(/\//g, '\\').toLowerCase() : rel;
  const up = `..${path.sep}`;
  const upCmp = isWin ? up.toLowerCase() : up;
  if (relCmp === '..' || relCmp.startsWith(upCmp)) return false;
  return true;
}

export function shouldTrustCursorWorkspace(workspace, { runId, createdByOrchestrator, worktreesRoot } = {}) {
  if (!createdByOrchestrator || !runId || !workspace) return false;
  if (path.basename(String(runId)) !== String(runId) || String(runId).includes('..')) return false;
  if (!existsSync(workspace)) return false;
  try {
    if (!statSync(workspace).isDirectory()) return false;
  } catch {
    return false;
  }

  const wtRoot = worktreesRoot || runtimeDirs().worktrees;
  if (!existsSync(wtRoot)) return false;

  const expected = path.join(wtRoot, String(runId));
  if (!existsSync(expected)) return false;
  if (!isInsideDir(wtRoot, workspace) || !isInsideDir(wtRoot, expected)) return false;
  return pathsEqual(workspace, expected);
}

export async function git(repo, args, { quiet = true } = {}) {
  const r = await runTool('git', args, { cwd: repo, timeoutMs: 120_000, quiet });
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.code})\n${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

export async function gitAllowFail(repo, args) {
  return runTool('git', args, { cwd: repo, timeoutMs: 120_000, quiet: true });
}

export async function resolveGitRootFromCwd(cwd = process.cwd()) {
  const candidate = path.resolve(cwd);
  const inside = await gitAllowFail(candidate, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw new Error(`Current folder is not inside a Git repository:\n${candidate}\nOpen the project repo in Cursor and retry. The orchestrator will not guess another repository.`);
  }
  return path.resolve(await git(candidate, ['rev-parse', '--show-toplevel']));
}

export async function resolveTaskRepo(repoFlag, cwd = process.cwd()) {
  if (repoFlag && String(repoFlag).trim()) {
    return path.resolve(String(repoFlag).trim());
  }
  return resolveGitRootFromCwd(cwd);
}

export async function inspectSourceRepo(repo) {
  const candidate = path.resolve(repo);
  const inside = await gitAllowFail(candidate, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw new Error(`Source directory is not a Git repository:\n${candidate}\nInitialize git and create at least one commit before running a modifying task.`);
  }

  const root = path.resolve(await git(candidate, ['rev-parse', '--show-toplevel']));
  const head = await gitAllowFail(root, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0) {
    throw new Error(`Git repository has no commits / invalid HEAD:\n${root}\nCreate an initial commit first. The orchestrator will not modify or invent history.`);
  }

  const status = await git(root, ['status', '--porcelain=v1']);
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { root, status, head: head.stdout.trim(), branch };
}

export function formatDirtyFiles(status) {
  const lines = String(status || '').split(/\r?\n/).map(s => s.trimEnd()).filter(Boolean);
  if (!lines.length) return '(none)';
  return lines.join('\n');
}

export async function gitState(repo) {
  const status = await runTool('git', ['status', '--short'], { cwd: repo, timeoutMs: 60_000, quiet: true });
  const unstaged = await runTool('git', ['diff', '--', '.'], { cwd: repo, timeoutMs: 60_000, quiet: true });
  const staged = await runTool('git', ['diff', '--cached', '--', '.'], { cwd: repo, timeoutMs: 60_000, quiet: true });
  return {
    status: status.stdout,
    diff: [
      '### git status --short', status.stdout || '(clean)',
      '\n### git diff', unstaged.stdout || '(none)',
      '\n### git diff --cached', staged.stdout || '(none)',
    ].join('\n'),
    patch: (unstaged.stdout || '') + (staged.stdout || ''),
  };
}

function compactStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function slugifyTask(task) {
  const ascii = String(task || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  return ascii || 'task';
}

export function makeRunId(task) {
  const stamp = compactStamp();
  const rand = randomBytes(3).toString('hex');
  return `${stamp}-${slugifyTask(task).slice(0, 24)}-${rand}`;
}

async function branchExists(repo, branch) {
  const local = await gitAllowFail(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (local.code === 0) return true;
  const any = await gitAllowFail(repo, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  return any.code === 0;
}

export async function createIsolatedWorktree(sourceRepo, task, requestedBranch, preferredRunId = '', env = process.env) {
  const dirs = runtimeDirs(env);
  await mkdir(dirs.worktrees, { recursive: true });

  if (requestedBranch && !BRANCH_RE.test(requestedBranch)) {
    throw new Error(`Unsafe or invalid --branch value: ${requestedBranch}`);
  }

  let lastError = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const runId = attempt === 0 && preferredRunId ? preferredRunId : makeRunId(task);
    const branch = requestedBranch || `ai/${runId}`;
    const worktree = path.join(dirs.worktrees, runId);

    if (!isInsideDir(dirs.worktrees, worktree)) {
      throw new Error(`Refusing to create worktree outside orchestrator worktrees dir: ${worktree}`);
    }
    if (existsSync(worktree)) {
      lastError = `worktree path exists: ${worktree}`;
      if (requestedBranch) break;
      continue;
    }
    if (await branchExists(sourceRepo, branch)) {
      lastError = `branch already exists: ${branch}`;
      if (requestedBranch) {
        throw new Error(`Refusing to reuse existing branch ${branch}. Choose a new --branch name.`);
      }
      continue;
    }

    console.log('\n--- GIT ISOLATION ---\n');
    console.log(`Creating branch : ${branch}`);
    console.log(`Creating worktree: ${worktree}`);

    const r = await runTool('git', ['worktree', 'add', '-b', branch, worktree, 'HEAD'], {
      cwd: sourceRepo,
      timeoutMs: 120_000,
    });
    if (r.code !== 0) {
      throw new Error(`Unable to create isolated git worktree.\n${r.stderr || r.stdout}`);
    }

    return { worktree, branch, runId, createdByOrchestrator: true };
  }

  throw new Error(`Unable to allocate a unique branch/worktree. ${lastError}`.trim());
}

export async function commitChanges(repo, task) {
  let hash = '';
  try {
    hash = await git(repo, ['rev-parse', 'HEAD']);
  } catch {
    hash = '';
  }
  const state = await gitState(repo);
  if (!state.status.trim()) {
    return { committed: false, reason: 'no changes to commit', hash };
  }

  await git(repo, ['add', '-A'], { quiet: false });
  const summary = task.replace(/\s+/g, ' ').trim().slice(0, 72) || 'automated task';
  const message = `ai: ${summary}`;
  await git(repo, ['commit', '-m', message], { quiet: false });
  hash = await git(repo, ['rev-parse', 'HEAD']);
  return { committed: true, reason: '', hash };
}

export function sourceFingerprint(info) {
  return `${info.head}\n${info.status || ''}`;
}

export function workingTreeChanged(before, after) {
  return (after.status || '').trim() !== (before.status || '').trim()
    || (after.patch || '') !== (before.patch || '');
}

export async function listWorktrees(repo) {
  const r = await gitAllowFail(repo, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return [];
  const paths = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length).trim());
  }
  return paths;
}

export async function removeOrchestratorWorktree({ sourceRepo, worktree, runId, createdByOrchestrator, env = process.env }) {
  if (!createdByOrchestrator || !worktree || !runId) {
    return { removed: false, reason: 'not an orchestrator worktree' };
  }
  const dirs = runtimeDirs(env);
  if (!isInsideDir(dirs.worktrees, worktree)) {
    return { removed: false, reason: 'path is outside orchestrator worktrees/' };
  }
  if (!pathsEqual(worktree, path.join(dirs.worktrees, runId))) {
    return { removed: false, reason: 'path does not match current run worktree' };
  }
  if (!existsSync(worktree)) {
    return { removed: false, reason: 'worktree directory missing' };
  }
  const listed = await listWorktrees(sourceRepo);
  const registered = listed.some(p => pathsEqual(p, worktree));
  if (!registered) {
    return { removed: false, reason: 'path is not a registered git worktree' };
  }
  const rm = await gitAllowFail(sourceRepo, ['worktree', 'remove', '--force', worktree]);
  if (rm.code !== 0) {
    return { removed: false, reason: rm.stderr || rm.stdout || 'git worktree remove failed' };
  }
  await gitAllowFail(sourceRepo, ['worktree', 'prune']);
  return { removed: true, reason: '' };
}
