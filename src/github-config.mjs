import path from 'node:path';
import { readFile } from 'node:fs/promises';

export const AUTOMATION_MODES = ['manual', 'assisted', 'autonomous'];

export const DEFAULT_REPO_AUTOMATION = Object.freeze({
  automation: {
    enabled: false,
    mode: 'manual',
    trigger_label: 'ai-auto',
    max_fix_attempts: 5,
    allowed_actors: [],
  },
  pull_request: {
    create: true,
    auto_merge: false,
  },
  tests: {
    required: true,
  },
  review: {
    required: true,
  },
  publish: {
    enabled: false,
  },
});

export class RepoConfigError extends Error {
  constructor(message, extras = {}) {
    super(message);
    this.name = 'RepoConfigError';
    this.code = extras.code || 'REPO_CONFIG';
    this.details = extras;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i).trimEnd();
  }
  return line;
}

function parseScalar(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/[&*!|]/.test(s) || s.startsWith('<<')) {
    throw new RepoConfigError(`Unsupported YAML construct: ${s}`, { code: 'YAML_UNSUPPORTED' });
  }
  return s;
}

/**
 * Conservative nested-map YAML parser for .github/ai-orchestrator.yml.
 * Rejects tabs, merge keys, aliases, and tags. Bad YAML fails closed.
 */
export function parseSimpleYaml(text) {
  const src = String(text ?? '');
  if (src.charCodeAt(0) === 0xfeff) {
    throw new RepoConfigError('YAML must be UTF-8 without BOM.', { code: 'YAML_BOM' });
  }
  if (src.includes('\t')) {
    throw new RepoConfigError('YAML must not contain tab characters.', { code: 'YAML_TABS' });
  }
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const original = lines[lineNo];
    if (!original.trim() || original.trim().startsWith('#')) continue;
    const trimmedRight = stripComment(original);
    if (!trimmedRight.trim()) continue;
    const indent = trimmedRight.length - trimmedRight.trimStart().length;
    const body = trimmedRight.trim();
    if (/^[&*!]/.test(body) || body.startsWith('<<:')) {
      throw new RepoConfigError(`Unsupported YAML on line ${lineNo + 1}.`, { code: 'YAML_UNSUPPORTED' });
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (!isPlainObject(parent) && !Array.isArray(parent)) {
      throw new RepoConfigError(`Invalid YAML nesting on line ${lineNo + 1}.`, { code: 'YAML_NESTING' });
    }

    if (body.startsWith('- ')) {
      if (!Array.isArray(parent)) {
        throw new RepoConfigError(`List item without a list on line ${lineNo + 1}.`, { code: 'YAML_LIST' });
      }
      parent.push(parseScalar(body.slice(2)));
      continue;
    }

    const colon = body.indexOf(':');
    if (colon < 1) {
      throw new RepoConfigError(`Invalid YAML mapping on line ${lineNo + 1}.`, { code: 'YAML_MAPPING' });
    }
    const key = body.slice(0, colon).trim();
    const rest = body.slice(colon + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      throw new RepoConfigError(`Invalid YAML key "${key}" on line ${lineNo + 1}.`, { code: 'YAML_KEY' });
    }
    if (!isPlainObject(parent)) {
      throw new RepoConfigError(`Invalid YAML mapping parent on line ${lineNo + 1}.`, { code: 'YAML_NESTING' });
    }
    if (rest === '') {
      const peek = peekNextMeaningful(lines, lineNo + 1);
      const nextIsList = peek && peek.trim().startsWith('- ');
      const child = nextIsList ? [] : {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseScalar(rest);
    }
  }
  return root;
}

function peekNextMeaningful(lines, start) {
  for (let i = start; i < lines.length; i++) {
    const t = stripComment(lines[i]);
    if (t.trim() && !t.trim().startsWith('#')) return t;
  }
  return '';
}

function expectBool(section, key, value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new RepoConfigError(`${section}.${key} must be true or false.`, { code: 'CONFIG_TYPE' });
  }
  return value;
}

function expectInt(section, key, value, fallback, { min, max }) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RepoConfigError(`${section}.${key} must be an integer.`, { code: 'CONFIG_TYPE' });
  }
  if (value < min || value > max) {
    throw new RepoConfigError(`${section}.${key} must be between ${min} and ${max}.`, { code: 'CONFIG_RANGE' });
  }
  return value;
}

function expectString(section, key, value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) {
    throw new RepoConfigError(`${section}.${key} must be a non-empty string.`, { code: 'CONFIG_TYPE' });
  }
  return value.trim();
}

function expectStringList(section, key, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) {
    throw new RepoConfigError(`${section}.${key} must be a list of GitHub usernames.`, { code: 'CONFIG_TYPE' });
  }
  return value.map(v => v.trim());
}

export function validateRepoConfig(raw) {
  if (raw == null) return structuredClone(DEFAULT_REPO_AUTOMATION);
  if (!isPlainObject(raw)) {
    throw new RepoConfigError('Repository automation config must be a mapping.', { code: 'CONFIG_ROOT' });
  }

  const allowedTop = new Set(['automation', 'pull_request', 'tests', 'review', 'publish']);
  for (const key of Object.keys(raw)) {
    if (!allowedTop.has(key)) {
      throw new RepoConfigError(`Unknown config section: ${key}.`, { code: 'CONFIG_UNKNOWN' });
    }
  }

  const automationIn = isPlainObject(raw.automation) ? raw.automation : (raw.automation === undefined ? {} : null);
  if (automationIn === null) throw new RepoConfigError('automation must be a mapping.', { code: 'CONFIG_TYPE' });
  const prIn = isPlainObject(raw.pull_request) ? raw.pull_request : (raw.pull_request === undefined ? {} : null);
  if (prIn === null) throw new RepoConfigError('pull_request must be a mapping.', { code: 'CONFIG_TYPE' });
  const testsIn = isPlainObject(raw.tests) ? raw.tests : (raw.tests === undefined ? {} : null);
  if (testsIn === null) throw new RepoConfigError('tests must be a mapping.', { code: 'CONFIG_TYPE' });
  const reviewIn = isPlainObject(raw.review) ? raw.review : (raw.review === undefined ? {} : null);
  if (reviewIn === null) throw new RepoConfigError('review must be a mapping.', { code: 'CONFIG_TYPE' });
  const publishIn = isPlainObject(raw.publish) ? raw.publish : (raw.publish === undefined ? {} : null);
  if (publishIn === null) throw new RepoConfigError('publish must be a mapping.', { code: 'CONFIG_TYPE' });

  const enabled = expectBool('automation', 'enabled', automationIn.enabled, false);
  const mode = expectString('automation', 'mode', automationIn.mode, 'manual').toLowerCase();
  if (!AUTOMATION_MODES.includes(mode)) {
    throw new RepoConfigError('automation.mode must be manual, assisted, or autonomous.', { code: 'CONFIG_MODE' });
  }
  const trigger = expectString('automation', 'trigger_label', automationIn.trigger_label, 'ai-auto');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trigger)) {
    throw new RepoConfigError('automation.trigger_label contains unsupported characters.', { code: 'CONFIG_LABEL' });
  }
  const maxFix = expectInt('automation', 'max_fix_attempts', automationIn.max_fix_attempts, 5, { min: 1, max: 5 });
  const allowedActors = expectStringList('automation', 'allowed_actors', automationIn.allowed_actors);

  const autoMerge = expectBool('pull_request', 'auto_merge', prIn.auto_merge, false);
  if (autoMerge === true) {
    throw new RepoConfigError('pull_request.auto_merge is not supported in v1.1. Automation must stop at READY FOR HUMAN MERGE.', { code: 'AUTO_MERGE_FORBIDDEN' });
  }
  const publishEnabled = expectBool('publish', 'enabled', publishIn.enabled, false);
  if (publishEnabled === true) {
    throw new RepoConfigError('publish.enabled is not supported in v1.1. Production publish/deploy stays disabled.', { code: 'PUBLISH_FORBIDDEN' });
  }

  if (enabled && mode === 'manual') {
    throw new RepoConfigError('automation.enabled is true but mode is manual. Set mode to assisted (or autonomous) or disable automation.', { code: 'CONFIG_CONFLICT' });
  }

  return {
    automation: {
      enabled,
      mode,
      trigger_label: trigger,
      max_fix_attempts: maxFix,
      allowed_actors: allowedActors,
    },
    pull_request: {
      create: expectBool('pull_request', 'create', prIn.create, true),
      auto_merge: false,
    },
    tests: {
      required: expectBool('tests', 'required', testsIn.required, true),
    },
    review: {
      required: expectBool('review', 'required', reviewIn.required, true),
    },
    publish: {
      enabled: false,
    },
  };
}

export function parseRepoConfigText(text) {
  return validateRepoConfig(parseSimpleYaml(text));
}

export function isIssueAutomationActive(config) {
  const c = config || DEFAULT_REPO_AUTOMATION;
  return Boolean(c.automation?.enabled) && (c.automation.mode === 'assisted' || c.automation.mode === 'autonomous');
}

export async function loadRepoConfigFile(readFile, filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      return { ok: true, missing: true, config: structuredClone(DEFAULT_REPO_AUTOMATION), path: filePath };
    }
    throw e;
  }
  try {
    const config = parseRepoConfigText(raw);
    return { ok: true, missing: false, config, path: filePath };
  } catch (e) {
    return {
      ok: false,
      missing: false,
      path: filePath,
      error: e instanceof Error ? e.message : String(e),
      config: structuredClone(DEFAULT_REPO_AUTOMATION),
    };
  }
}

export function repoConfigPath(repoRoot) {
  return path.join(String(repoRoot || ''), '.github', 'ai-orchestrator.yml');
}

export async function loadRepoAutomationConfig(repoRoot) {
  return loadRepoConfigFile(readFile, repoConfigPath(repoRoot));
}
