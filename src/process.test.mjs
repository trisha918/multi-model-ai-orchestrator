import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeProcess, isRetryableFailure } from './process.mjs';
import { loadConfig } from './config.mjs';

test('timeout handling marks timedOut and does not succeed', async () => {
  const r = await executeProcess(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
    timeoutMs: 400,
    quiet: true,
    maxRetries: 0,
  });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.exitCode, 0);
});

test('non-retryable failures are not retried', async () => {
  const r = await executeProcess(process.execPath, ['-e', 'process.exit(1)'], {
    timeoutMs: 10_000,
    quiet: true,
    maxRetries: 1,
  });
  assert.equal(r.attempts, 1);
  assert.equal(r.exitCode, 1);
  assert.equal(isRetryableFailure({ exitCode: 1, stdout: 'ok', stderr: '' }), false);
  assert.equal(isRetryableFailure({ timedOut: true, stdout: '', stderr: '' }), true);
  assert.equal(isRetryableFailure({ stderr: 'rate limit 429 try again', stdout: '' }), true);
  assert.equal(isRetryableFailure({ stderr: 'not authenticated', stdout: '', authFailure: true }), false);
});

test('retryable stderr is retried up to the limit', async () => {
  const r = await executeProcess(process.execPath, ['-e', "console.error('rate limit 429 try again'); process.exit(1)"], {
    timeoutMs: 10_000,
    quiet: true,
    maxRetries: 1,
  });
  assert.equal(r.attempts, 2);
  assert.equal(r.exitCode, 1);
});

test('argv special characters are preserved exactly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-argv-'));
  const script = path.join(dir, 'echo.mjs');
  await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))\n', 'utf8');
  const samples = [
    'Fix this! Do not break it.',
    'Use "hello" & preserve behavior.',
    'Check a|b and x>y.',
    "Don't change API!",
    '100% ^ready <ok>',
  ];
  try {
    for (const sample of samples) {
      const r = await executeProcess(process.execPath, [script, sample], { timeoutMs: 10_000, quiet: true });
      assert.equal(r.exitCode, 0, r.stderr);
      const parsed = JSON.parse(r.stdout.trim());
      assert.equal(parsed[0], sample);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config env overrides', () => {
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
