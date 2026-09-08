import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { isWin, spawnCommand } from './tooling.mjs';

function redact(text) {
  return String(text || '').replace(
    /(api[_-]?key|token|authorization|secret|password)\s*[:=]\s*\S+/gi,
    '$1: [redacted]'
  );
}

export function killProcessTree(pid) {
  if (!pid) return;
  if (isWin) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

export function isRetryableFailure(result) {
  if (!result) return false;
  if (result.authFailure) return false;
  const blob = `${result.stdout || ''}\n${result.stderr || ''}\n${result.error || ''}`.toLowerCase();
  if (/not authenticated|login required|unauthorized|invalid api key/.test(blob)) return false;
  if (result.timedOut) return true;
  if (result.spawnError && /econnreset|etimedout|eai_again|enotfound|econnrefused/.test(blob)) return true;
  if (/rate limit|try again|temporar|network|econnreset|503|429/.test(blob)) return true;
  return false;
}

export function executeProcess(command, args, {
  cwd,
  input = null,
  timeoutMs = 30 * 60 * 1000,
  quiet = false,
  env,
  maxRetries = 0,
} = {}) {
  const attempts = Math.max(0, Number(maxRetries) || 0) + 1;
  const label = [command, ...(args || [])].join(' ');

  async function once(attempt) {
    const started = Date.now();
    return new Promise(resolve => {
      let child;
      try {
        child = spawnCommand(command, args, { cwd, env });
      } catch (e) {
        resolve({
          command: label,
          exitCode: null,
          signal: null,
          timedOut: false,
          durationMs: Date.now() - started,
          stdout: '',
          stderr: '',
          spawnError: true,
          error: e.message,
          attempt,
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let finished = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid);
      }, timeoutMs);

      child.stdout?.on('data', d => {
        stdout += d.toString();
        if (!quiet) process.stdout.write(d);
      });
      child.stderr?.on('data', d => {
        stderr += d.toString();
        if (!quiet) process.stderr.write(d);
      });
      child.on('error', err => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({
          command: label,
          exitCode: null,
          signal: null,
          timedOut,
          durationMs: Date.now() - started,
          stdout: redact(stdout),
          stderr: redact(stderr),
          spawnError: true,
          error: err.message,
          attempt,
        });
      });
      child.on('close', (code, signal) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({
          command: label,
          exitCode: code,
          signal,
          timedOut,
          durationMs: Date.now() - started,
          stdout: redact(stdout),
          stderr: redact(stderr),
          spawnError: false,
          attempt,
        });
      });
      if (input !== null) child.stdin.write(input);
      child.stdin.end();
    });
  }

  return (async () => {
    let last;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempts > 1) console.log(`attempt ${attempt}`);
      last = await once(attempt);
      last.attempts = attempt;
      if (!last.timedOut && last.exitCode === 0) return last;
      if (attempt < attempts && isRetryableFailure(last)) {
        console.log(`retryable failure on attempt ${attempt}; retrying`);
        continue;
      }
      return last;
    }
    return last;
  })();
}
