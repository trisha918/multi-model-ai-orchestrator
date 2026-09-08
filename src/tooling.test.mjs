import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteCmdArgument, needsCmdWrapper, isWin, runTool } from './tooling.mjs';

test('cmd quoting wraps spaces and doubles quotes', () => {
  assert.equal(quoteCmdArgument('simple'), 'simple');
  assert.equal(quoteCmdArgument('hello world'), '"hello world"');
  assert.equal(quoteCmdArgument('say "hi"'), '"say ""hi"""');
  assert.equal(quoteCmdArgument('100%'), '100%%');
});

test('cmd quoting wraps shell metacharacters', () => {
  assert.equal(quoteCmdArgument('a&b'), '"a&b"');
  assert.equal(quoteCmdArgument('a|b'), '"a|b"');
});

test('cmd wrapper only for bat/cmd on Windows', () => {
  if (isWin) {
    assert.equal(needsCmdWrapper('C:\\x\\agent.cmd'), true);
    assert.equal(needsCmdWrapper('C:\\x\\agy.exe'), false);
  } else {
    assert.equal(needsCmdWrapper('/usr/bin/agy'), false);
  }
});

test('npm.cmd spawn works without shell:true', async () => {
  const r = await runTool('npm', ['--version'], { timeoutMs: 30_000, quiet: true });
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.match(r.stdout.trim(), /^\d+\.\d+/);
});
