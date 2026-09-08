import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { planCleanup, applyCleanup } from './cleanup.mjs';

test('cleanup only targets orchestrator artifact names under runs/ and worktrees/', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-clean-'));
  const oldName = '20200101T000000Z-old-aaaaaa';
  const newName = '20990101T000000Z-new-bbbbbb';
  const evil = path.join(root, 'not-managed', oldName);
  await mkdir(path.join(root, 'runs', oldName), { recursive: true });
  await mkdir(path.join(root, 'worktrees', newName), { recursive: true });
  await mkdir(evil, { recursive: true });
  await writeFile(path.join(root, 'runs', oldName, 'x.txt'), 'x', 'utf8');
  const oldDate = new Date('2020-01-02T00:00:00Z');
  await utimes(path.join(root, 'runs', oldName), oldDate, oldDate);
  try {
    const plan = planCleanup({ olderThanDays: 7, now: Date.now(), root });
    const oldItem = plan.find(p => p.path.endsWith(oldName));
    const newItem = plan.find(p => p.path.endsWith(newName));
    assert.equal(oldItem.action, 'remove');
    assert.equal(newItem.action, 'keep');
    assert.ok(!plan.some(p => p.path.includes('not-managed')));

    const dry = applyCleanup(plan, { apply: false, root });
    assert.equal(existsSync(path.join(root, 'runs', oldName)), true);
    assert.ok(dry.preserved.some(p => p.action === 'dry-run-remove'));

    const applied = applyCleanup(plan, { apply: true, root });
    assert.equal(applied.removed.length, 1);
    assert.equal(existsSync(path.join(root, 'runs', oldName)), false);
    assert.equal(existsSync(path.join(root, 'worktrees', newName)), true);
    assert.equal(existsSync(evil), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
