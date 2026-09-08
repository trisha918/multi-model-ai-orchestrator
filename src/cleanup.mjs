import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { packageRoot } from './tooling.mjs';
import { isInsideDir, runtimeDirs } from './workspace.mjs';

const RUN_ID_RE = /^\d{8}T\d{6}Z-/;

function parseCleanupArgs(argv) {
  const out = { apply: false, olderThanDays: 7 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--older-than-days') out.olderThanDays = Math.max(0, Number(argv[++i] ?? 7) || 7);
  }
  return out;
}

function isOrchestratorArtifactName(name) {
  return RUN_ID_RE.test(name);
}

function listManagedDirs() {
  const dirs = runtimeDirs();
  return { runs: dirs.runs, worktrees: dirs.worktrees };
}

export function planCleanup({ olderThanDays = 7, now = Date.now(), root } = {}) {
  const dirs = root
    ? { runs: path.join(root, 'runs'), worktrees: path.join(root, 'worktrees') }
    : listManagedDirs();
  const cutoff = now - olderThanDays * 24 * 60 * 60 * 1000;
  const candidates = [];

  for (const [kind, base] of [['runs', dirs.runs], ['worktrees', dirs.worktrees]]) {
    void kind;
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isOrchestratorArtifactName(entry.name)) continue;
      const folder = path.join(base, entry.name);
      if (!isInsideDir(base, folder)) continue;
      let mtime = 0;
      try { mtime = statSync(folder).mtimeMs; } catch { continue; }
      if (mtime > cutoff) candidates.push({ path: folder, action: 'keep', reason: 'newer than cutoff' });
      else candidates.push({ path: folder, action: 'remove', reason: `older than ${olderThanDays} days` });
    }
  }
  return candidates;
}

export function applyCleanup(plan, { apply = false, root } = {}) {
  const removed = [];
  const preserved = [];
  const base = root || packageRoot();
  const runsRoot = path.join(base, 'runs');
  const wtRoot = path.join(base, 'worktrees');
  for (const item of plan) {
    if (item.action !== 'remove') {
      preserved.push(item);
      continue;
    }
    if (!apply) {
      preserved.push({ ...item, action: 'dry-run-remove' });
      continue;
    }
    if (!isInsideDir(runsRoot, item.path) && !isInsideDir(wtRoot, item.path)) {
      preserved.push({ ...item, action: 'keep', reason: 'outside managed roots' });
      continue;
    }
    rmSync(item.path, { recursive: true, force: true });
    removed.push(item);
  }
  return { removed, preserved };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseCleanupArgs(process.argv.slice(2));
  const plan = planCleanup({ olderThanDays: opts.olderThanDays });
  const result = applyCleanup(plan, { apply: opts.apply });
  console.log(opts.apply ? 'AI Orchestrator cleanup (apply)' : 'AI Orchestrator cleanup (dry-run)');
  console.log(`Older than ${opts.olderThanDays} days\n`);
  for (const item of result.removed) console.log(`REMOVED  ${item.path}`);
  for (const item of result.preserved) console.log(`${item.action === 'dry-run-remove' ? 'WOULD REMOVE' : 'KEEP   '}  ${item.path}  (${item.reason || item.action})`);
  if (!result.removed.length && !result.preserved.length) console.log('(no matching artifacts)');
  if (!opts.apply) console.log('\nRe-run with --apply to delete WOULD REMOVE entries.');
}
