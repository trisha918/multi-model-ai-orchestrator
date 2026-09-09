import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  mergeConfigLayers,
  validateConfigValue,
  writeUserConfigFile,
  readUserConfigFile,
  loadConfig,
  DEFAULTS,
} from './config.mjs';

test('config env overrides built-in defaults', () => {
  const c = loadConfig({
    AI_CURSOR_TIMEOUT_MS: '1000',
    AI_KEEP_SUCCESS_WORKTREES: 'true',
    AI_KEEP_FAILED_WORKTREES: 'false',
    AI_WORKER_MAX_RETRIES: '3',
  });
  assert.equal(c.cursorTimeoutMs, 1000);
  assert.equal(c.keepSuccessWorktrees, true);
  assert.equal(c.keepFailedWorktrees, false);
  assert.equal(c.workerMaxRetries, 3);
});

test('config precedence: env overrides user config overrides defaults', () => {
  const c = mergeConfigLayers({
    defaults: DEFAULTS,
    userConfig: { defaultMode: 'team', cursorModel: 'composer', workerMaxRetries: 2 },
    env: { AI_DEFAULT_MODE: 'codex' },
  });
  assert.equal(c.defaultMode, 'codex');
  assert.equal(c.cursorModel, 'composer');
  assert.equal(c.workerMaxRetries, 2);
  const d = mergeConfigLayers({
    defaults: DEFAULTS,
    userConfig: {},
    env: {},
  });
  assert.equal(d.defaultMode, 'auto');
});

test('config validation accepts known keys and rejects bad values', () => {
  assert.equal(validateConfigValue('defaultMode', 'auto'), 'auto');
  assert.equal(validateConfigValue('defaultMode', 'agy'), 'agy');
  assert.equal(validateConfigValue('keepSuccessWorktrees', 'true'), true);
  assert.equal(validateConfigValue('workerMaxRetries', '1'), 1);
  assert.throws(() => validateConfigValue('defaultMode', 'nope'));
  assert.throws(() => validateConfigValue('workerMaxRetries', '9'));
  assert.throws(() => validateConfigValue('unknownKey', 'x'));
});

test('config show/path file writes are atomic and isolated by config dir override', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai orch config-'));
  const env = { ...process.env, AI_ORCHESTRATOR_CONFIG_DIR: dir };
  try {
    const written = await writeUserConfigFile({ defaultMode: 'cursor', cursorModel: 'auto' }, env);
    assert.equal(written.path, path.join(dir, 'config.json'));
    const file = await readUserConfigFile(env);
    assert.equal(file.defaultMode, 'cursor');
    const effective = mergeConfigLayers({ userConfig: file, env: { AI_CURSOR_MODEL: 'other' } });
    assert.equal(effective.cursorModel, 'other');
    assert.equal(effective.defaultMode, 'cursor');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
