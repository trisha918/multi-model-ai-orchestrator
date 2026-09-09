import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { executeProcess } from './process.mjs';
import { resolveTool } from './tooling.mjs';
import { cursorAgentLaunchSpec } from './cursor-agent.mjs';
import {
  emptyRegistry,
  finalizeRegistry,
  normalizeModelRecord,
} from './model-registry.mjs';

export const GEMINI_MODELS_FIXTURE = `Fetching available models...
gemini-3.8-flash-high	Gemini 3.8 Flash (High)
gemini-3.8-flash-medium	Gemini 3.8 Flash (Medium)
gemini-3.8-flash-low	Gemini 3.8 Flash (Low)
gemini-3.7-flash-high	Gemini 3.7 Flash (High)
gemini-3.1-pro-high	Gemini 3.1 Pro (High)
gemini-3.1-pro-low	Gemini 3.1 Pro (Low)
`;

export function parseAgyModelsOutput(text, { now = new Date().toISOString() } = {}) {
  const models = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^fetching available models/i.test(trimmed) || /^available/i.test(trimmed)) continue;
    const parts = trimmed.split(/\s{2,}|\t/);
    const id = (parts[0] || '').trim();
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._+/=-]*$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const displayName = (parts.slice(1).join(' ').trim() || id);
    models.push(normalizeModelRecord({
      provider: 'gemini',
      id,
      displayName,
      available: true,
      source: 'agy models',
      lastChecked: now,
    }));
  }
  return models;
}

export function parseCursorModelsOutput(text, { now = new Date().toISOString() } = {}) {
  const models = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^available models$/i.test(trimmed) || /^tip:/i.test(trimmed)) continue;
    const m = /^([A-Za-z0-9._+/\[\],=-]+)\s+-\s+(.+)$/.exec(trimmed);
    if (!m) continue;
    const id = m[1].trim();
    if (seen.has(id)) continue;
    seen.add(id);
    models.push(normalizeModelRecord({
      provider: 'cursor',
      id,
      displayName: m[2].trim(),
      available: true,
      source: 'cursor --list-models',
      lastChecked: now,
    }));
  }
  if (!seen.has('auto')) {
    models.unshift(normalizeModelRecord({
      provider: 'cursor',
      id: 'auto',
      displayName: 'Auto',
      available: true,
      source: 'cursor --list-models',
      lastChecked: now,
    }));
  }
  return models;
}

export function parseCodexModelsCache(json, { now = new Date().toISOString() } = {}) {
  const models = [];
  const list = Array.isArray(json?.models) ? json.models : [];
  for (const entry of list) {
    const id = String(entry?.slug || entry?.id || '').trim();
    if (!id) continue;
    const visibility = String(entry.visibility || 'list').toLowerCase();
    const listed = visibility === 'list';
    models.push(normalizeModelRecord({
      provider: 'codex',
      id,
      displayName: String(entry.display_name || id),
      available: listed ? true : null,
      source: 'codex models_cache.json',
      lastChecked: json.fetched_at || now,
      effort: entry.default_reasoning_level || '',
    }));
  }
  return models;
}

export function parseCodexConfigToml(text) {
  const m = /^\s*model\s*=\s*"?([^"\r\n]+)"?\s*$/m.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

function defaultCodexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function discoverCodexFromLocalFiles({ env = process.env, now = new Date().toISOString() } = {}) {
  const home = defaultCodexHome(env);
  const cacheFile = path.join(home, 'models_cache.json');
  const configFile = path.join(home, 'config.toml');
  const models = [];
  let source = '';
  if (existsSync(cacheFile)) {
    try {
      const raw = JSON.parse(readFileSync(cacheFile, 'utf8'));
      models.push(...parseCodexModelsCache(raw, { now }));
      source = 'codex models_cache.json';
    } catch {
      source = 'codex models_cache.json (unreadable)';
    }
  }
  let configured = '';
  if (existsSync(configFile)) {
    try {
      configured = parseCodexConfigToml(readFileSync(configFile, 'utf8'));
    } catch {
      configured = '';
    }
  }
  if (configured) {
    const existing = models.find(m => m.id === configured);
    if (existing) {
      existing.available = true;
      existing.aliases = [...new Set([...(existing.aliases || []), 'configured'])];
    } else {
      models.push(normalizeModelRecord({
        provider: 'codex',
        id: configured,
        displayName: configured,
        available: true,
        source: 'codex config.toml',
        lastChecked: now,
      }));
    }
    source = source ? `${source}; config.toml` : 'codex config.toml';
  }
  const listed = models.filter(m => m.available === true);
  const status = listed.length ? (source.includes('models_cache') ? 'ok' : 'partial') : (models.length ? 'partial' : 'unavailable');
  return { status, source: source || 'codex CLI has no models subcommand', lastChecked: now, models };
}

export async function discoverGeminiLive({ now = new Date().toISOString(), runner } = {}) {
  const run = runner || (async () => {
    const cmd = resolveTool('agy');
    return executeProcess(cmd, ['models'], { timeoutMs: 60_000, quiet: true });
  });
  const r = await run();
  if (!r || r.exitCode !== 0) {
    return {
      status: 'unavailable',
      source: 'agy models',
      lastChecked: now,
      models: [],
      error: r?.stderr || r?.error || `exit ${r?.exitCode}`,
    };
  }
  const models = parseAgyModelsOutput(`${r.stdout || ''}\n${r.stderr || ''}`, { now });
  return {
    status: models.length ? 'ok' : 'unavailable',
    source: 'agy models',
    lastChecked: now,
    models,
  };
}

export async function discoverCursorLive({ now = new Date().toISOString(), runner } = {}) {
  const run = runner || (async () => {
    const spec = cursorAgentLaunchSpec();
    return executeProcess(spec.command, [...spec.prefix, '--list-models'], { timeoutMs: 60_000, quiet: true });
  });
  const r = await run();
  if (!r || r.exitCode !== 0) {
    return {
      status: 'unavailable',
      source: 'cursor --list-models',
      lastChecked: now,
      models: [normalizeModelRecord({
        provider: 'cursor',
        id: 'auto',
        displayName: 'Auto',
        available: true,
        source: 'built-in fallback',
        lastChecked: now,
      })],
      error: r?.stderr || r?.error || `exit ${r?.exitCode}`,
    };
  }
  const models = parseCursorModelsOutput(`${r.stdout || ''}\n${r.stderr || ''}`, { now });
  return {
    status: models.length ? 'ok' : 'partial',
    source: 'cursor --list-models',
    lastChecked: now,
    models,
  };
}

export async function discoverAll({ env = process.env, now = new Date().toISOString(), runners = {} } = {}) {
  const registry = emptyRegistry(now);
  const gemini = await discoverGeminiLive({ now, runner: runners.gemini });
  const cursor = await discoverCursorLive({ now, runner: runners.cursor });
  const codex = discoverCodexFromLocalFiles({ env, now });
  registry.providers.gemini = gemini;
  registry.providers.cursor = cursor;
  registry.providers.codex = codex;
  registry.lastChecked = now;
  return finalizeRegistry(registry);
}
