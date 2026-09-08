import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { cursorAgentLaunchSpec, buildCursorAgentArgs, runCursorAgentCli } from './cursor-agent.mjs';

const launch = cursorAgentLaunchSpec();
console.log(`Cursor command: ${launch.command}`);
if (launch.prefix.length) console.log(`Cursor script: ${launch.prefix[launch.prefix.length - 1]}`);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-cursor-'));

try {
  const status = await runCursorAgentCli(['status'], { cwd: tmp, timeoutMs: 60_000, quiet: true });
  console.log('\n--- STATUS ---');
  console.log(status.stdout || status.stderr || `(exit ${status.exitCode})`);
  if (status.exitCode !== 0) {
    console.error('\nCursor is not authenticated. Run the resolved agent.cmd with `login` and retry.');
    process.exitCode = 1;
  } else {
    console.log('\n--- HEADLESS TEST ---');
    const args = buildCursorAgentArgs({
      prompt: 'Reply with exactly: CURSOR_AGENT_OK',
      model: 'auto',
      readOnly: true,
      trust: true,
    });
    const test = await runCursorAgentCli(args, { cwd: tmp, timeoutMs: 180_000, quiet: true });
    console.log(test.stdout || test.stderr);
    if (test.exitCode !== 0 || !/CURSOR_AGENT_OK/.test(test.stdout)) {
      process.exitCode = 1;
    } else {
      console.log('\nCURSOR_AGENT_OK');
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
