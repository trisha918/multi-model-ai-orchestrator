export const PROVIDERS = ['cursor', 'codex', 'gemini'];
export const PROFILES = ['auto', 'fast', 'balanced', 'strong', 'max'];
export const CODEX_FAMILIES = ['luna', 'terra', 'sol', 'astra'];
export const GEMINI_VARIANT_ALIASES = ['flash-low', 'flash-medium', 'flash-high', 'pro-low', 'pro-high'];

const MODEL_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._+/=-]*$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+/\[\],=-]*$/;

export class ModelSelectionError extends Error {
  constructor(message, extras = {}) {
    super(message);
    this.name = 'ModelSelectionError';
    this.code = extras.code || 'MODEL_SELECTION';
    this.details = extras;
  }
}

export function isSafeModelToken(value) {
  return MODEL_TOKEN_RE.test(String(value || ''));
}

export function isSafeModelId(value) {
  return MODEL_ID_RE.test(String(value || ''));
}

export function assertSafeModelValue(value, { exactId = false } = {}) {
  const s = String(value || '').trim();
  if (!s) throw new ModelSelectionError('Model value cannot be empty.');
  if (/\s/.test(s) || /[&|<>^%]/.test(s)) {
    throw new ModelSelectionError('Model value contains unsupported characters.');
  }
  if (exactId ? !isSafeModelId(s) : !isSafeModelToken(s) && !isSafeModelId(s)) {
    throw new ModelSelectionError('Model value contains unsupported characters.');
  }
  return s;
}

export function isProfile(value) {
  return PROFILES.includes(String(value || '').trim().toLowerCase());
}

export function isAutoToken(value) {
  const s = String(value ?? 'auto').trim().toLowerCase();
  return s === '' || s === 'auto';
}

export function compareVersionParts(a, b) {
  const pa = String(a).split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => Number.parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export function parseGeminiId(id) {
  const raw = String(id || '').trim();
  const m = /^gemini-(\d+(?:\.\d+)*)-(flash|pro)(?:-(minimal|low|medium|high))?$/i.exec(raw);
  if (!m) return null;
  return {
    id: raw,
    version: m[1],
    family: m[2].toLowerCase(),
    effort: (m[3] || '').toLowerCase(),
    variantAlias: m[3] ? `${m[2].toLowerCase()}-${m[3].toLowerCase()}` : m[2].toLowerCase(),
  };
}

export function geminiVariantAlias(id) {
  return parseGeminiId(id)?.variantAlias || '';
}

export function parseCodexFamily(id) {
  const raw = String(id || '').trim().toLowerCase();
  if (raw === 'codex-auto-review') return '';
  const m = raw.match(/\b(astra|sol|terra|luna|reserve)\b/);
  return m ? m[1] : '';
}

export function availabilityLabel(available) {
  if (available === true) return 'YES';
  if (available === false) return 'NO';
  return 'UNKNOWN';
}

export function normalizeModelRecord(partial = {}) {
  const id = String(partial.id || '').trim();
  const provider = String(partial.provider || '').trim().toLowerCase();
  const available = partial.available === true ? true : partial.available === false ? false : null;
  const aliases = [...new Set((partial.aliases || []).map(a => String(a).trim().toLowerCase()).filter(Boolean))];
  return {
    provider,
    id,
    displayName: String(partial.displayName || id),
    aliases,
    tier: partial.tier || '',
    speed: partial.speed || '',
    effort: partial.effort || '',
    available,
    source: String(partial.source || ''),
    lastChecked: partial.lastChecked || '',
  };
}

export function emptyRegistry(now = new Date().toISOString()) {
  return {
    lastChecked: now,
    providers: {
      cursor: { status: 'unavailable', source: '', lastChecked: '', models: [] },
      codex: { status: 'unavailable', source: '', lastChecked: '', models: [] },
      gemini: { status: 'unavailable', source: '', lastChecked: '', models: [] },
    },
  };
}

function assignGeminiTiers(models) {
  const newestByVariant = new Map();
  for (const m of models) {
    const parsed = parseGeminiId(m.id);
    if (!parsed) continue;
    const prev = newestByVariant.get(parsed.variantAlias);
    if (!prev || compareVersionParts(parsed.version, parseGeminiId(prev.id).version) > 0) {
      newestByVariant.set(parsed.variantAlias, m);
    }
  }
  for (const m of models) {
    const parsed = parseGeminiId(m.id);
    if (!parsed) {
      m.tier = m.tier || 'balanced';
      continue;
    }
    m.aliases = [...new Set([...(m.aliases || []), parsed.variantAlias])];
    if (newestByVariant.get(parsed.variantAlias) === m) {
      m.aliases = [...new Set([...m.aliases, parsed.variantAlias])];
    }
    if (parsed.family === 'flash' && parsed.effort === 'low') m.tier = 'fast';
    else if (parsed.family === 'flash' && parsed.effort === 'medium') m.tier = 'balanced';
    else if (parsed.family === 'flash' && parsed.effort === 'high') m.tier = 'strong';
    else if (parsed.family === 'pro' && parsed.effort === 'low') m.tier = 'strong';
    else if (parsed.family === 'pro' && parsed.effort === 'high') m.tier = 'max';
    else m.tier = m.tier || 'balanced';
    m.speed = parsed.family === 'flash' ? 'fast' : 'slow';
    m.effort = parsed.effort;
  }
}

function assignCodexTiers(models) {
  const newestByFamily = new Map();
  for (const m of models) {
    const family = parseCodexFamily(m.id);
    if (!family || family === 'reserve') continue;
    const prev = newestByFamily.get(family);
    if (!prev) newestByFamily.set(family, m);
  }
  for (const m of models) {
    const family = parseCodexFamily(m.id);
    if (family && CODEX_FAMILIES.includes(family) && newestByFamily.get(family) === m) {
      m.aliases = [...new Set([...(m.aliases || []), family])];
    }
    if (family === 'luna') m.tier = 'fast';
    else if (family === 'terra') m.tier = 'balanced';
    else if (family === 'sol') m.tier = 'strong';
    else if (family === 'astra') m.tier = 'max';
    else if (family === 'reserve') m.tier = 'fast';
    else m.tier = m.tier || 'balanced';
  }
}

function assignCursorTiers(models) {
  for (const m of models) {
    const id = m.id.toLowerCase();
    if (id === 'auto') {
      m.tier = 'auto';
      m.aliases = [...new Set([...(m.aliases || []), 'auto'])];
      continue;
    }
    if (/\bmax\b/.test(id) || /xhigh/.test(id)) m.tier = 'max';
    else if (/-fast$/.test(id) || /\blow-fast\b/.test(id)) m.tier = 'fast';
    else if (/\blow\b/.test(id) && !/thinking/.test(id)) m.tier = 'fast';
    else if (/\bhigh\b/.test(id) || /thinking/.test(id) || /composer-2\.5$/.test(id)) m.tier = 'strong';
    else m.tier = 'balanced';
  }
}

export function finalizeRegistry(registry) {
  const out = registry || emptyRegistry();
  for (const provider of PROVIDERS) {
    const bucket = out.providers[provider] || { models: [] };
    bucket.models = (bucket.models || []).map(normalizeModelRecord).filter(m => m.id);
    if (provider === 'gemini') assignGeminiTiers(bucket.models);
    if (provider === 'codex') assignCodexTiers(bucket.models);
    if (provider === 'cursor') assignCursorTiers(bucket.models);
  }
  return out;
}

export function listModels(registry, provider) {
  return registry?.providers?.[provider]?.models || [];
}

export function availableModels(registry, provider) {
  return listModels(registry, provider).filter(m => m.available === true);
}

export function findModelById(registry, provider, id) {
  const wanted = String(id || '').trim();
  return listModels(registry, provider).find(m => m.id === wanted) || null;
}

function aliasMatches(model, alias) {
  const a = String(alias || '').toLowerCase();
  if (!a) return false;
  if ((model.aliases || []).includes(a)) return true;
  if (model.id.toLowerCase() === a) return true;
  if (model.tier && model.tier === a) return false;
  return false;
}

export function resolveAlias(registry, provider, alias) {
  const token = String(alias || '').trim();
  if (!token) return null;
  const models = listModels(registry, provider);
  const exact = models.find(m => m.id === token);
  if (exact) return exact;
  const lower = token.toLowerCase();
  const aliased = models.filter(m => (m.aliases || []).includes(lower));
  if (aliased.length === 0) return models.find(m => m.id.toLowerCase() === lower) || null;
  const confirmed = aliased.filter(m => m.available === true);
  const pool = confirmed.length ? confirmed : aliased;
  if (provider === 'gemini') {
    pool.sort((a, b) => {
      const pa = parseGeminiId(a.id);
      const pb = parseGeminiId(b.id);
      return compareVersionParts(pb?.version || '0', pa?.version || '0');
    });
  }
  return pool[0] || null;
}

const PROFILE_FALLBACK = {
  max: ['max', 'strong', 'balanced', 'fast'],
  strong: ['strong', 'max', 'balanced', 'fast'],
  balanced: ['balanced', 'strong', 'fast', 'max'],
  fast: ['fast', 'balanced', 'strong', 'max'],
};

function modelsForTier(registry, provider, tier) {
  return availableModels(registry, provider).filter(m => m.tier === tier);
}

export function resolveProfile(registry, provider, profile) {
  const p = String(profile || 'balanced').toLowerCase();
  if (p === 'auto') {
    if (provider === 'cursor') {
      const auto = availableModels(registry, provider).find(m => m.id === 'auto')
        || listModels(registry, provider).find(m => m.id === 'auto');
      if (auto) return { model: auto, profile: 'auto', fallback: false, reason: 'Cursor Auto is the safe default' };
    }
    return resolveProfile(registry, provider, 'balanced');
  }
  const chain = PROFILE_FALLBACK[p] || PROFILE_FALLBACK.balanced;
  for (let i = 0; i < chain.length; i++) {
    const tier = chain[i];
    const hits = modelsForTier(registry, provider, tier);
    if (hits.length === 0) continue;
    if (provider === 'gemini') {
      hits.sort((a, b) => compareVersionParts(parseGeminiId(b.id)?.version || '0', parseGeminiId(a.id)?.version || '0'));
    }
    if (provider === 'codex') {
      const familyOrder = { astra: 4, sol: 3, terra: 2, luna: 1 };
      hits.sort((a, b) => (familyOrder[parseCodexFamily(b.id)] || 0) - (familyOrder[parseCodexFamily(a.id)] || 0));
    }
    return {
      model: hits[0],
      profile: tier,
      preferred: p,
      fallback: tier !== p,
      reason: tier === p
        ? `Selected ${tier} capability`
        : `No available ${p}-tier model detected`,
    };
  }
  if (provider === 'cursor') {
    const auto = listModels(registry, provider).find(m => m.id === 'auto');
    if (auto) {
      return {
        model: auto,
        profile: 'auto',
        preferred: p,
        fallback: true,
        reason: `No available ${p}-tier Cursor model detected; using Auto`,
      };
    }
  }
  return null;
}

export function formatUnavailableManual({ provider, requested, registry }) {
  const models = listModels(registry, provider);
  const lines = [
    'REQUESTED MODEL UNAVAILABLE',
    '',
    'Worker:',
    String(provider || '').toUpperCase(),
    '',
    'Requested:',
    requested,
    '',
    'Available models:',
  ];
  const confirmed = models.filter(m => m.available === true);
  if (confirmed.length === 0) {
    lines.push('(none confirmed)');
  } else {
    for (const m of confirmed) {
      lines.push(`${m.id}${m.aliases?.length ? `  aliases: ${m.aliases.join(', ')}` : ''}`);
    }
  }
  lines.push('', 'Run:', '/ai-models', '', 'to see current choices.');
  return lines.join('\n');
}

function pad(s, n) {
  const t = String(s ?? '');
  if (t.length >= n) return t.slice(0, n);
  return t + ' '.repeat(n - t.length);
}

export function formatModelsReport(registry) {
  const lines = [
    'MULTI-MODEL AI ORCHESTRATOR — MODELS',
    '',
  ];
  for (const provider of ['codex', 'gemini', 'cursor']) {
    const bucket = registry?.providers?.[provider] || { models: [], source: '', status: 'unavailable' };
    lines.push(provider.toUpperCase());
    lines.push(`Discovery: ${bucket.status || 'unavailable'}${bucket.source ? ` (${bucket.source})` : ''}`);
    if (provider === 'cursor') {
      lines.push(`${pad('Alias', 12)}  ${pad('Actual model', 34)}  Available`);
      lines.push(`${pad('-'.repeat(10), 12)}  ${pad('-'.repeat(23), 34)}  ---------`);
    } else {
      lines.push(`${pad('Alias', 14)}  ${pad('Actual model', 28)}  ${pad('Available', 10)}  Tier`);
      lines.push(`${pad('-'.repeat(13), 14)}  ${pad('-'.repeat(25), 28)}  ${pad('-'.repeat(10), 10)}  --------`);
    }
    const rows = [];
    const seen = new Set();
    const aliasesWanted = provider === 'codex'
      ? ['fast', 'balanced', 'strong', 'max', ...CODEX_FAMILIES]
      : provider === 'gemini'
        ? ['fast', 'balanced', 'strong', 'max', ...GEMINI_VARIANT_ALIASES]
        : ['auto', 'fast', 'balanced', 'strong', 'max'];
    for (const alias of aliasesWanted) {
      let resolved = isProfile(alias)
        ? resolveProfile(registry, provider, alias)?.model
        : resolveAlias(registry, provider, alias);
      if (alias === 'auto' && provider === 'cursor') {
        resolved = resolveAlias(registry, provider, 'auto') || resolved;
      }
      if (!resolved) {
        if (provider === 'cursor' && alias === 'auto') {
          rows.push({ alias, id: '(not discovered)', available: null, tier: 'auto' });
        } else if (!isProfile(alias)) {
          rows.push({ alias, id: '(not detected)', available: false, tier: '' });
        }
        continue;
      }
      seen.add(resolved.id);
      rows.push({
        alias,
        id: resolved.id,
        available: resolved.available,
        tier: resolved.tier,
      });
    }
    for (const row of rows) {
      if (provider === 'cursor') {
        lines.push(`${pad(row.alias, 12)}  ${pad(row.id, 34)}  ${availabilityLabel(row.available)}`);
      } else {
        lines.push(`${pad(row.alias, 14)}  ${pad(row.id, 28)}  ${pad(availabilityLabel(row.available), 10)}  ${row.tier || ''}`);
      }
    }
    const extra = availableModels(registry, provider).filter(m => !seen.has(m.id));
    if (extra.length) {
      lines.push(`(+ ${extra.length} additional discovered ids; not shown as aliases)`);
    }
    lines.push('');
  }
  if (registry?.lastChecked) lines.push(`Last checked: ${registry.lastChecked}`);
  return lines.join('\n');
}

export { aliasMatches };
