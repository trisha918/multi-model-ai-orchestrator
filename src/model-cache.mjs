import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { modelsCachePath, userConfigDir } from './paths.mjs';
import { atomicWriteJson } from './config.mjs';
import { discoverAll } from './model-discovery.mjs';
import { emptyRegistry, finalizeRegistry } from './model-registry.mjs';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export function sanitizeCache(raw) {
  const now = new Date().toISOString();
  const base = emptyRegistry(raw?.lastChecked || now);
  if (!raw || typeof raw !== 'object') return finalizeRegistry(base);
  for (const provider of ['cursor', 'codex', 'gemini']) {
    const bucket = raw.providers?.[provider] || {};
    base.providers[provider] = {
      status: bucket.status || 'unavailable',
      source: String(bucket.source || ''),
      lastChecked: bucket.lastChecked || '',
      models: (bucket.models || []).map(m => ({
        provider,
        id: String(m.id || ''),
        displayName: String(m.displayName || m.id || ''),
        aliases: Array.isArray(m.aliases) ? m.aliases.map(String) : [],
        tier: m.tier || '',
        speed: m.speed || '',
        effort: m.effort || '',
        available: m.available === true ? true : m.available === false ? false : null,
        source: String(m.source || ''),
        lastChecked: m.lastChecked || '',
      })).filter(m => m.id),
    };
  }
  base.lastChecked = raw.lastChecked || now;
  return finalizeRegistry(base);
}

export async function readModelsCache(env = process.env) {
  const file = modelsCachePath(env);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return sanitizeCache(parsed);
  } catch {
    return null;
  }
}

export async function writeModelsCache(registry, env = process.env) {
  const dir = userConfigDir(env);
  await mkdir(dir, { recursive: true });
  const file = modelsCachePath(env);
  const clean = sanitizeCache(registry);
  await atomicWriteJson(file, clean);
  return file;
}

export function cacheIsFresh(cache, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!cache?.lastChecked) return false;
  const ts = Date.parse(cache.lastChecked);
  if (!Number.isFinite(ts)) return false;
  return now - ts < ttlMs;
}

export async function loadRegistry({ env = process.env, refresh = false, runners, now } = {}) {
  if (!refresh) {
    const cached = await readModelsCache(env);
    if (cached && cacheIsFresh(cached)) return { registry: cached, fromCache: true, path: modelsCachePath(env) };
  }
  const registry = await discoverAll({ env, now: now || new Date().toISOString(), runners });
  const file = await writeModelsCache(registry, env);
  return { registry, fromCache: false, path: file };
}

export { DEFAULT_TTL_MS, modelsCachePath };
