import process from 'node:process';

function envInt(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function envBool(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

export const DEFAULTS = {
  cursorTimeoutMs: 5 * 60 * 1000,
  codexTimeoutMs: 10 * 60 * 1000,
  geminiTimeoutMs: 5 * 60 * 1000,
  testTimeoutMs: 10 * 60 * 1000,
  workerMaxRetries: 1,
  keepSuccessWorktrees: false,
  keepFailedWorktrees: true,
};

export function loadConfig(env = process.env) {
  return {
    cursorTimeoutMs: envInt(env, 'AI_CURSOR_TIMEOUT_MS', DEFAULTS.cursorTimeoutMs),
    codexTimeoutMs: envInt(env, 'AI_CODEX_TIMEOUT_MS', DEFAULTS.codexTimeoutMs),
    geminiTimeoutMs: envInt(env, 'AI_GEMINI_TIMEOUT_MS', DEFAULTS.geminiTimeoutMs),
    testTimeoutMs: envInt(env, 'AI_TEST_TIMEOUT_MS', DEFAULTS.testTimeoutMs),
    workerMaxRetries: envInt(env, 'AI_WORKER_MAX_RETRIES', DEFAULTS.workerMaxRetries),
    keepSuccessWorktrees: envBool(env, 'AI_KEEP_SUCCESS_WORKTREES', DEFAULTS.keepSuccessWorktrees),
    keepFailedWorktrees: envBool(env, 'AI_KEEP_FAILED_WORKTREES', DEFAULTS.keepFailedWorktrees),
  };
}

export const config = loadConfig();
