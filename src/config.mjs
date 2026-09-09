import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { normalizeMode } from './router.mjs';
import { userConfigDir, userConfigPath } from './paths.mjs';

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

function envStr(env, name, fallback) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return String(raw).trim();
}

export const DEFAULTS = {
  defaultMode: 'auto',
  cursorModel: 'auto',
  codexModel: 'auto',
  geminiModel: 'auto',
  team: {
    cursorModel: 'auto',
    codexModel: 'auto',
    geminiModel: 'auto',
  },
  cursorTimeoutMs: 5 * 60 * 1000,
  codexTimeoutMs: 10 * 60 * 1000,
  geminiTimeoutMs: 5 * 60 * 1000,
  testTimeoutMs: 10 * 60 * 1000,
  workerMaxRetries: 1,
  keepSuccessWorktrees: false,
  keepFailedWorktrees: true,
};

export const USER_CONFIG_KEYS = [
  'defaultMode',
  'cursorModel',
  'codexModel',
  'geminiModel',
  'teamCursorModel',
  'teamCodexModel',
  'teamGeminiModel',
  'keepSuccessWorktrees',
  'keepFailedWorktrees',
  'workerMaxRetries',
];

const BOOL_KEYS = new Set(['keepSuccessWorktrees', 'keepFailedWorktrees']);
const INT_KEYS = new Set(['workerMaxRetries']);

export function parseBoolSetting(value) {
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`Invalid boolean value: ${value}. Use true or false.`);
}

export function validateConfigValue(key, value) {
  if (!USER_CONFIG_KEYS.includes(key)) {
    throw new Error(`Unknown config key: ${key}. Allowed: ${USER_CONFIG_KEYS.join(', ')}`);
  }
  if (key === 'defaultMode') {
    const mode = normalizeMode(value);
    if (!mode) throw new Error('defaultMode must be auto, cursor, codex, gemini, agy, or team.');
    return mode === 'gemini' && String(value).trim().toLowerCase() === 'agy' ? 'agy' : mode;
  }
  if (['cursorModel', 'codexModel', 'geminiModel', 'teamCursorModel', 'teamCodexModel', 'teamGeminiModel'].includes(key)) {
    const s = String(value).trim();
    if (!s) throw new Error(`${key} cannot be empty.`);
    if (!/^[A-Za-z0-9._+/=-]+$/.test(s)) throw new Error(`${key} contains unsupported characters.`);
    return s;
  }
  if (BOOL_KEYS.has(key)) return parseBoolSetting(value);
  if (key === 'workerMaxRetries') {
    const n = Number(value);
    if (!Number.isInteger(n) && String(value).trim() !== String(Math.floor(n))) {
      const parsed = Number.parseInt(String(value), 10);
      if (!Number.isFinite(parsed) || String(parsed) !== String(value).trim()) {
        throw new Error('workerMaxRetries must be an integer from 0 to 5.');
      }
    }
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5) {
      throw new Error('workerMaxRetries must be an integer from 0 to 5.');
    }
    return parsed;
  }
  return value;
}

function pickUserKeys(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  const expanded = { ...obj };
  if (obj.team && typeof obj.team === 'object') {
    if (obj.team.cursorModel != null) expanded.teamCursorModel = obj.team.cursorModel;
    if (obj.team.codexModel != null) expanded.teamCodexModel = obj.team.codexModel;
    if (obj.team.geminiModel != null) expanded.teamGeminiModel = obj.team.geminiModel;
  }
  for (const key of USER_CONFIG_KEYS) {
    if (expanded[key] === undefined) continue;
    try {
      out[key] = validateConfigValue(key, expanded[key]);
    } catch {
      /* ignore invalid stored keys; env/defaults still apply */
    }
  }
  return out;
}

export async function readUserConfigFile(env = process.env) {
  const file = userConfigPath(env);
  if (!existsSync(file)) return {};
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return pickUserKeys(parsed);
  } catch {
    return {};
  }
}

export async function atomicWriteJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, file);
}

export async function writeUserConfigFile(updates, env = process.env) {
  const dir = userConfigDir(env);
  const file = userConfigPath(env);
  await mkdir(dir, { recursive: true });
  const current = await readUserConfigFile(env);
  const next = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    next[key] = validateConfigValue(key, value);
  }
  await atomicWriteJson(file, next);
  return { path: file, config: next };
}

/**
 * Precedence: environment variable → user config → built-in default.
 * CLI flags are applied later by the command parser.
 */
export function mergeConfigLayers({ defaults = DEFAULTS, userConfig = {}, env = process.env } = {}) {
  const file = pickUserKeys(userConfig);
  const base = { ...defaults, ...file };
  const teamDefaults = defaults.team || DEFAULTS.team;
  return {
    defaultMode: envStr(env, 'AI_DEFAULT_MODE', base.defaultMode),
    cursorModel: envStr(env, 'AI_CURSOR_MODEL', base.cursorModel),
    codexModel: envStr(env, 'AI_CODEX_MODEL', base.codexModel || 'auto'),
    geminiModel: envStr(env, 'AI_GEMINI_MODEL', base.geminiModel || 'auto'),
    team: {
      cursorModel: file.teamCursorModel || teamDefaults.cursorModel,
      codexModel: file.teamCodexModel || teamDefaults.codexModel,
      geminiModel: file.teamGeminiModel || teamDefaults.geminiModel,
    },
    cursorTimeoutMs: envInt(env, 'AI_CURSOR_TIMEOUT_MS', base.cursorTimeoutMs),
    codexTimeoutMs: envInt(env, 'AI_CODEX_TIMEOUT_MS', base.codexTimeoutMs),
    geminiTimeoutMs: envInt(env, 'AI_GEMINI_TIMEOUT_MS', base.geminiTimeoutMs),
    testTimeoutMs: envInt(env, 'AI_TEST_TIMEOUT_MS', base.testTimeoutMs),
    workerMaxRetries: envInt(env, 'AI_WORKER_MAX_RETRIES', base.workerMaxRetries),
    keepSuccessWorktrees: envBool(env, 'AI_KEEP_SUCCESS_WORKTREES', base.keepSuccessWorktrees),
    keepFailedWorktrees: envBool(env, 'AI_KEEP_FAILED_WORKTREES', base.keepFailedWorktrees),
  };
}

export function loadConfig(env = process.env) {
  return mergeConfigLayers({ env, userConfig: {} });
}

export async function loadResolvedConfig(env = process.env) {
  const userConfig = await readUserConfigFile(env);
  return mergeConfigLayers({ env, userConfig });
}

export const CONFIG_PRECEDENCE = ['CLI argument', 'environment variable', 'user config', 'smart auto selection', 'built-in default'];

export const config = loadConfig();
