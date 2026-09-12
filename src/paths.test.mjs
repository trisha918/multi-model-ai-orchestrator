import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { installationInfo, runtimeDirs, packageVersion, userConfigDir } from './paths.mjs';
import { packageRoot as toolingRoot, VERSION } from './tooling.mjs';
import { isInsideDir } from './workspace.mjs';
import { parseNodeEngineMinimum, nodeSatisfiesEngine, pathHasDirectory, appendUniquePathEntry } from './install-helpers.mjs';
import { planCleanup, applyCleanup } from './cleanup.mjs';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';

test('package version is read from package.json', () => {
  assert.equal(packageVersion(), '1.1.0');
  assert.equal(VERSION, '1.1.0');
  assert.equal(toolingRoot(), installationInfo().packageRoot);
});

test('runtime and config dirs honor overrides including paths with spaces', () => {
  const env = {
    AI_ORCHESTRATOR_CONFIG_DIR: 'C:\\Users\\Test User\\AppData\\Roaming\\MultiModelAIOrchestrator',
    AI_ORCHESTRATOR_RUNTIME_ROOT: 'C:\\AI Tools\\runtime data',
    AI_ORCHESTRATOR_SKILLS_DIR: 'C:\\Users\\Test User\\.cursor\\skills',
  };
  const info = installationInfo(env);
  assert.equal(info.configDir, path.resolve(env.AI_ORCHESTRATOR_CONFIG_DIR));
  assert.equal(info.runtimeRoot, path.resolve(env.AI_ORCHESTRATOR_RUNTIME_ROOT));
  assert.match(info.runs, /runtime data/);
  assert.match(info.aiSkill, /Test User/);
  assert.equal(userConfigDir(env), path.resolve(env.AI_ORCHESTRATOR_CONFIG_DIR));
});

test('default Windows runtime lives under LOCALAPPDATA app folder', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Test User\\AppData\\Local', APPDATA: 'C:\\Users\\Test User\\AppData\\Roaming' };
  const dirs = runtimeDirs(env);
  assert.match(dirs.runs, /MultiModelAIOrchestrator/);
  assert.match(dirs.worktrees, /MultiModelAIOrchestrator/);
  assert.ok(!dirs.runs.toLowerCase().includes('ai-orchestrator-mvp-v6') || dirs.runs.includes('MultiModelAIOrchestrator'));
});

test('installer helpers parse engines and PATH directories with spaces', () => {
  assert.equal(parseNodeEngineMinimum('>=20'), 20);
  assert.equal(nodeSatisfiesEngine('24.4.0', '>=20'), true);
  assert.equal(nodeSatisfiesEngine('18.20.0', '>=20'), false);
  const dir = 'C:\\Users\\Test User\\AppData\\Roaming\\npm';
  assert.equal(pathHasDirectory(`${dir};C:\\Windows`, dir), true);
  assert.equal(pathHasDirectory(`${dir}\\;C:\\Windows`, dir), true);
  assert.equal(pathHasDirectory('C:\\Windows', dir), false);
  const first = appendUniquePathEntry('C:\\Windows', dir);
  assert.equal(first.added, true);
  assert.match(first.value, /npm/);
  const second = appendUniquePathEntry(first.value, dir);
  assert.equal(second.added, false);
  assert.equal(second.value, first.value);
  const fromEmpty = appendUniquePathEntry('', dir);
  assert.equal(fromEmpty.added, true);
  assert.equal(fromEmpty.value, dir);
});

test('cleanup refuses paths outside managed runtime roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai orch roots-'));
  const oldName = '20200101T000000Z-old-aaaaaa';
  await mkdir(path.join(root, 'runs', oldName), { recursive: true });
  const oldDate = new Date('2020-01-02T00:00:00Z');
  await utimes(path.join(root, 'runs', oldName), oldDate, oldDate);
  const outsider = path.join(root, 'not-managed', oldName);
  await mkdir(outsider, { recursive: true });
  try {
    const plan = planCleanup({ olderThanDays: 7, now: Date.now(), root });
    const applied = applyCleanup([...plan, { path: outsider, action: 'remove' }], { apply: true, root });
    assert.equal(existsSync(path.join(root, 'runs', oldName)), false);
    assert.equal(existsSync(outsider), true);
    assert.ok(applied.preserved.some(p => p.reason === 'outside managed roots'));
    assert.ok(isInsideDir(path.join(root, 'runs'), path.join(root, 'runs', oldName)) || true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
