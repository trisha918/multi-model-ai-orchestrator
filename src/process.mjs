import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { isWin, spawnCommand } from './tooling.mjs';

function redact(text) {
  return String(text || '').replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(
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
  maxOutputBytes = 4 * 1024 * 1024,
} = {}) {
  const secrets = Object.entries(env || process.env).filter(([key, value]) => /key|token|password|secret/i.test(key) && String(value).length >= 6).map(([,value]) => String(value));
  const clean = text => {
    let value = String(text || '');
    for (const secret of secrets) value = value.split(secret).join('[redacted]');
    return redact(value);
  };
  const attempts = Math.max(0, Number(maxRetries) || 0) + 1;
  const label = clean([command, ...(args || [])].join(' '));

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
      const outDecoder = new StringDecoder('utf8');
      const errDecoder = new StringDecoder('utf8');
      let finished = false;
      let timedOut = false;
      let outputBytes = 0;
      let outputLimit = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid);
      }, timeoutMs);

      child.stdout?.on('data', d => {
        outputBytes += d.length;
        if (outputBytes <= maxOutputBytes) stdout += outDecoder.write(d);
        else { outputLimit = true; killProcessTree(child.pid); }
      });
      child.stderr?.on('data', d => {
        outputBytes += d.length;
        if (outputBytes <= maxOutputBytes) stderr += errDecoder.write(d);
        else { outputLimit = true; killProcessTree(child.pid); }
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
          stdout: clean(stdout),
          stderr: clean(stderr),
          spawnError: true,
          error: err.message,
          attempt,
        });
      });
      child.on('close', (code, signal) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // Redact complete output to handle secrets split across stream chunks.
        stdout += outDecoder.end(); stderr += errDecoder.end();
        if (!quiet) { process.stdout.write(clean(stdout)); process.stderr.write(clean(stderr)); }
        resolve({
          command: label,
          exitCode: outputLimit ? 1 : code,
          outputLimit,
          signal,
          timedOut,
          durationMs: Date.now() - started,
          stdout: clean(stdout),
          stderr: clean(stderr),
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
