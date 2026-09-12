import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { runTask } from './orchestrator.mjs';

test('successful runTask returns 0', async () => {
  const prev = process.exitCode;
  try {
    const code = await runTask(['--task', 'return-zero-check', '--repo', os.tmpdir()], {
      printTaskAndExit: true,
    });
    assert.equal(code, 0);
  } finally {
    process.exitCode = prev;
  }
});

test('failed runTask returns non-zero without terminating the parent process', async () => {
  const prev = process.exitCode;
  try {
    const code = await runTask(['--repo', os.tmpdir()]);
    assert.equal(typeof code, 'number');
    assert.notEqual(code, 0);
    assert.ok(true, 'parent test process continued after failed runTask');
  } finally {
    process.exitCode = prev;
  }
});
