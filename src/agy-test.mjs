import { resolveTool, runProcess } from './tooling.mjs';

const command = resolveTool('agy');
const args = ['-p', 'Reply with exactly: ANTIGRAVITY_OK', '--output-format', 'json', '--print-timeout', '2m'];
const r = await runProcess(command, args, { timeoutMs: 180_000, quiet: true });

if (r.code !== 0) {
  console.error('Antigravity headless test failed.');
  if (r.stderr.trim()) console.error(r.stderr.trim());
  process.exitCode = 1;
} else {
  try {
    const j = JSON.parse(r.stdout);
    const response = String(j.response ?? '').trim();
    console.log('status  :', j.status ?? '(unknown)');
    console.log('response:', response);
    if ((j.status && j.status !== 'SUCCESS') || !/ANTIGRAVITY_OK/.test(response)) {
      process.exitCode = 1;
    } else {
      console.log('ANTIGRAVITY_OK');
    }
  } catch {
    console.log(r.stdout.trim());
    if (!/ANTIGRAVITY_OK/.test(r.stdout)) process.exitCode = 1;
    else console.log('ANTIGRAVITY_OK');
  }
}
