import { isRetryableFailure } from './process.mjs';
import { appendEvent } from './local-store.mjs';

export class BudgetExceeded extends Error {
  constructor(message) { super(message); this.stageStatus = 'BUDGET'; }
}

// Intentionally retain only OS/tool configuration and provider settings. GitHub
// credentials are for the privileged adapter, never the worker/test subprocess.
export function workerEnvironment(env = process.env) {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|HOMEDRIVE|HOMEPATH|USERNAME|USER|SHELL|TERM|LANG|LC_.+|CI|NO_COLOR|FORCE_COLOR|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|CODEX_HOME|CURSOR_.+|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY)$/i;
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.test(key)));
}

export function controlledExecutor(execute, { maxSeconds = 3600, maxProcesses = 20, env, events, now = Date.now } = {}) {
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || !Number.isInteger(maxProcesses) || maxProcesses < 1) throw new Error('Budgets require positive seconds and a positive integer process count');
  const started = now();
  let calls = 0;
  const check = () => {
    if (now() - started >= maxSeconds * 1000) throw new BudgetExceeded('Run time budget exhausted');
    if (calls >= maxProcesses) throw new BudgetExceeded('Run process budget exhausted');
  };
  const exec = async (command, args, opts = {}) => {
    const retries = Math.max(0, Number(opts.maxRetries) || 0);
    for (let attempt = 0; ; attempt++) {
      check();
      calls++;
      if (events) await appendEvent(events, 'process.started', { call: calls, executable: String(command), cwd: opts.cwd });
      const remaining = maxSeconds * 1000 - (now() - started);
      const result = await execute(command, args, { ...opts, env: workerEnvironment(env), timeoutMs: Math.max(1, Math.min(opts.timeoutMs || remaining, remaining)), maxRetries: 0 });
      if (events) await appendEvent(events, 'process.finished', { call: calls, exitCode: result.exitCode, timedOut: Boolean(result.timedOut) });
      if (now() - started >= maxSeconds * 1000) throw new BudgetExceeded('Run time budget exhausted');
      if (attempt >= retries || !isRetryableFailure(result) || result.exitCode === 0) return { ...result, attempts: attempt + 1 };
    }
  };
  return { exec, check, usage: () => ({ processCalls: calls, durationMs: now() - started }) };
}

export function validateImplementationOutput(result, { branch, sha, testsRequired = true, reviewRequired = true } = {}) {
  if (!result || result.version !== 1 || result.ok !== true) throw new Error('Missing successful structured execution result');
  if (result.branch !== branch || !/^ai\/[A-Za-z0-9._/-]+$/.test(branch || '')) throw new Error('Implementation branch does not match the authorized AI branch');
  if (!/^[0-9a-f]{40,64}$/i.test(sha || '') || result.commit !== sha) throw new Error('Implementation commit does not match the branch head');
  if (testsRequired && result.tests !== 'PASS') throw new Error('Required independent tests did not pass');
  if (reviewRequired && result.review !== 'PASS') throw new Error('Required review did not pass');
  return result;
}
