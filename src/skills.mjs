import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { cursorSkillsRoot } from './paths.mjs';
import { resolveAlias, resolveProfile, isProfile } from './model-registry.mjs';

export const SKILL_OWNER = 'multi-model-ai-orchestrator';

export const CORE_SKILLS = [
  {
    name: 'ai',
    mode: 'auto',
    description: 'Run the local multi-model AI orchestrator. It automatically routes work among Cursor Agent models, Codex, and Gemini/Antigravity, then auto-selects a model.',
  },
  {
    name: 'ai-team',
    mode: 'team',
    description: 'Run the multi-agent team workflow: Cursor Agent plans, Codex implements, and Gemini/Antigravity reviews with an auto-fix loop and per-stage auto models.',
  },
  {
    name: 'ai-cursor',
    mode: 'cursor',
    description: 'Force Cursor Agent with automatic Cursor model selection.',
  },
  {
    name: 'ai-codex',
    mode: 'codex',
    description: 'Force Codex with automatic Codex model selection based on task complexity.',
  },
  {
    name: 'ai-gemini',
    mode: 'gemini',
    description: 'Force Gemini/Antigravity with automatic Gemini model selection based on task complexity.',
  },
  {
    name: 'ai-models',
    kind: 'models',
    description: 'Show discovered Cursor, Codex, and Gemini models, aliases, profiles, and availability from the local orchestrator registry.',
  },
];

export const PROFILE_SKILLS = [
  { name: 'ai-codex-fast', mode: 'codex', model: 'fast', description: 'Force Codex using the fast capability profile.' },
  { name: 'ai-codex-balanced', mode: 'codex', model: 'balanced', description: 'Force Codex using the balanced capability profile.' },
  { name: 'ai-codex-strong', mode: 'codex', model: 'strong', description: 'Force Codex using the strong capability profile.' },
  { name: 'ai-codex-max', mode: 'codex', model: 'max', description: 'Force Codex using the max capability profile.' },
  { name: 'ai-gemini-fast', mode: 'gemini', model: 'fast', description: 'Force Gemini using the fast capability profile.' },
  { name: 'ai-gemini-balanced', mode: 'gemini', model: 'balanced', description: 'Force Gemini using the balanced capability profile.' },
  { name: 'ai-gemini-strong', mode: 'gemini', model: 'strong', description: 'Force Gemini using the strong capability profile.' },
  { name: 'ai-gemini-max', mode: 'gemini', model: 'max', description: 'Force Gemini using the max capability profile.' },
];

export const CURATED_ALIAS_SKILLS = [
  { name: 'ai-codex-sol', mode: 'codex', model: 'sol', description: 'Force Codex using the current verified Sol-family model.' },
  { name: 'ai-codex-terra', mode: 'codex', model: 'terra', description: 'Force Codex using the current verified Terra-family model.' },
  { name: 'ai-codex-luna', mode: 'codex', model: 'luna', description: 'Force Codex using the current verified Luna-family model.' },
  { name: 'ai-gemini-flash-high', mode: 'gemini', model: 'flash-high', description: 'Force Gemini using the current verified Flash High model.' },
  { name: 'ai-gemini-flash-medium', mode: 'gemini', model: 'flash-medium', description: 'Force Gemini using the current verified Flash Medium model.' },
  { name: 'ai-gemini-flash-low', mode: 'gemini', model: 'flash-low', description: 'Force Gemini using the current verified Flash Low model.' },
  { name: 'ai-gemini-pro-high', mode: 'gemini', model: 'pro-high', description: 'Force Gemini using the current verified Pro High model.' },
  { name: 'ai-gemini-pro-low', mode: 'gemini', model: 'pro-low', description: 'Force Gemini using the current verified Pro Low model.' },
];

export function aliasSkillSupported(spec, registry) {
  if (!registry) return false;
  if (isProfile(spec.model)) {
    const resolved = resolveProfile(registry, spec.mode, spec.model);
    return Boolean(resolved?.model && resolved.model.available === true && !resolved.fallback);
  }
  const aliased = resolveAlias(registry, spec.mode, spec.model);
  return Boolean(aliased && aliased.available === true);
}

export function skillsToInstall(registry) {
  const list = [...CORE_SKILLS, ...PROFILE_SKILLS];
  for (const spec of CURATED_ALIAS_SKILLS) {
    if (aliasSkillSupported(spec, registry)) list.push(spec);
  }
  return list;
}

function invokeArgs(spec) {
  if (spec.kind === 'models') return "ai-orchestrator @('models')";
  const parts = ["'run'", "'--repo'", '$gitRoot', "'--mode'", `'${spec.mode}'`];
  if (spec.model) parts.push("'--model'", `'${spec.model}'`);
  parts.push("'--commit-on-pass'", "'--task-file'", '$taskFile');
  return `ai-orchestrator @(${parts.join(',')})`;
}

export function skillMarkdown(spec) {
  const { name, description } = spec;
  if (spec.kind === 'models') {
    return `---
name: ${name}
description: ${description}
disable-model-invocation: true
owned-by: ${SKILL_OWNER}
---
# ${name}

Use this skill only when the user explicitly invokes /${name}.

## Procedure
1. Do not implement a coding task. This command is informational.
2. Do not require a Git project. Call the global \`ai-orchestrator\` CLI.
3. Never interpolate user text into a PowerShell, cmd.exe, or native command string.
4. Invoke the global command with an argument array:

\`& ${invokeArgs(spec)}\`

5. Wait for the process to finish. Then report the models table: provider, alias, exact model, profile/tier, availability, and discovery source.
6. Do not fabricate availability. If discovery failed, say so.
`;
  }
  return `---
name: ${name}
description: ${description}
disable-model-invocation: true
owned-by: ${SKILL_OWNER}
---
# ${name}

Use this skill only when the user explicitly invokes /${name}.

## Procedure
1. Treat the text in the same user message after /${name} as the task. If there is no task text, ask for it.
2. Do not implement the task yourself. Delegate it to the global \`ai-orchestrator\` CLI.
3. Resolve the Git root of the currently opened Cursor workspace. From that workspace, run \`git rev-parse --show-toplevel\`. If Git root detection fails, stop with a clear error. Do not guess another repository. Do not use the orchestrator installation directory unless that is the opened workspace.
4. Never interpolate the task into a PowerShell, cmd.exe, or native command string. Never pass the task as \`--task\`. Never call a clone-specific script path.
5. Write the user's verbatim task to a unique inbox file. Do not use Set-Content. On Windows PowerShell 5 use UTF-8 without BOM:

\`$inbox = Join-Path $env:TEMP 'MultiModelAIOrchestrator\\task-inbox'\`
\`New-Item -ItemType Directory -Path $inbox -Force | Out-Null\`
\`$taskFile = Join-Path $inbox ('task-' + [guid]::NewGuid().ToString('n') + '.txt')\`
\`$utf8NoBom = New-Object System.Text.UTF8Encoding($false)\`
\`[System.IO.File]::WriteAllText($taskFile, $task, $utf8NoBom)\`

where \`$task\` is a PowerShell variable holding the exact user text (not interpolated into a native command).
6. Invoke the global command with an argument array. The only path tokens are the Git root and the temp file path (not the task text):

\`& ${invokeArgs(spec)}\`

7. After the CLI returns, delete only that same inbox file if it is the file this invocation created. Do not delete other files. Do not add \`--in-place\`.
8. Wait for the process to finish. Then report the Route banner (CURSOR, CODEX, GEMINI, or TEAM), Model Selection (AUTO or MANUAL), resolved model id, each stage result, branch/worktree, commit hash if any, and run-log path.
9. If the orchestrator refuses because the source repo is dirty, tell the user to commit or stash their current changes; do not clean or discard files automatically.
10. Keep the task bytes identical to the user's message. Do not rewrite or summarize the task.
`;
}

export function classifySkillContent(content) {
  const text = String(content || '');
  if (/owned-by:\s*multi-model-ai-orchestrator\b/.test(text)) return 'ours';
  if (/local multi-model (AI )?orchestrator/i.test(text) && /run-task\.ps1/i.test(text)) return 'ours';
  if (/ai-orchestrator\s+run/.test(text) && /\/ai-team|mode team|--mode auto/.test(text)) return 'ours';
  return 'foreign';
}

export function skillUsesGlobalCli(content) {
  const text = String(content || '');
  return /(?:^|[^A-Za-z0-9_-])ai-orchestrator(?![A-Za-z0-9_-])/.test(text);
}

export function skillUsesLosslessTaskTransport(content) {
  const text = String(content || '');
  if (/ai-orchestrator @\('models'\)/.test(text) && !/'--task'/.test(text)) return true;
  return /--task-file/.test(text) && !/'--task',\s*\$task/.test(text);
}

export function skillContainsClonePath(content) {
  return /[A-Za-z]:\\/.test(content) || /\/(?:Users|home)\//.test(content);
}

export function skillPath(name, env = process.env) {
  return path.join(cursorSkillsRoot(env), name, 'SKILL.md');
}

function ownedSkillDirs(env = process.env) {
  const root = cursorSkillsRoot(env);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

export async function installSkills({ env = process.env, force = false, registry = null } = {}) {
  const specs = skillsToInstall(registry);
  const wanted = new Set(specs.map(s => s.name));
  const results = [];
  for (const spec of specs) {
    const file = skillPath(spec.name, env);
    const dir = path.dirname(file);
    await mkdir(dir, { recursive: true });
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8');
      const owner = classifySkillContent(existing);
      if (owner !== 'ours' && !force) {
        results.push({
          name: spec.name,
          status: 'skipped-foreign',
          path: file,
          message: `Existing /${spec.name} skill is not owned by this project. It was left unchanged. Move or rename it, then retry.`,
        });
        continue;
      }
    }
    const markdown = skillMarkdown(spec);
    await writeFile(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
    results.push({ name: spec.name, status: 'installed', path: file });
  }

  for (const name of ownedSkillDirs(env)) {
    if (wanted.has(name)) continue;
    const file = skillPath(name, env);
    if (!existsSync(file)) continue;
    const existing = readFileSync(file, 'utf8');
    if (classifySkillContent(existing) !== 'ours') continue;
    if (!/^ai(-|$)/.test(name)) continue;
    await rm(path.dirname(file), { recursive: true, force: true });
    results.push({ name, status: 'removed-stale', path: file });
  }
  return results;
}

export async function uninstallSkills({ env = process.env } = {}) {
  const results = [];
  const names = new Set([
    ...CORE_SKILLS.map(s => s.name),
    ...PROFILE_SKILLS.map(s => s.name),
    ...CURATED_ALIAS_SKILLS.map(s => s.name),
    ...ownedSkillDirs(env),
  ]);
  for (const name of names) {
    const file = skillPath(name, env);
    const dir = path.dirname(file);
    if (!existsSync(file)) {
      if (CORE_SKILLS.some(s => s.name === name)) results.push({ name, status: 'missing', path: file });
      continue;
    }
    const existing = readFileSync(file, 'utf8');
    if (classifySkillContent(existing) !== 'ours') {
      results.push({
        name,
        status: 'skipped-foreign',
        path: file,
        message: `Existing /${name} skill is not owned by this project. It was left unchanged.`,
      });
      continue;
    }
    await rm(dir, { recursive: true, force: true });
    results.push({ name, status: 'removed', path: file });
  }
  return results;
}

export function skillStatus(env = process.env, registry = null) {
  const specs = skillsToInstall(registry);
  return specs.map(spec => {
    const file = skillPath(spec.name, env);
    if (!existsSync(file)) return { name: spec.name, ok: false, status: 'missing', path: file, kind: spec.kind || 'task' };
    const content = readFileSync(file, 'utf8');
    const owner = classifySkillContent(content);
    const usesGlobalCli = skillUsesGlobalCli(content);
    const lossless = skillUsesLosslessTaskTransport(content);
    const hasClonePath = skillContainsClonePath(content);
    const ok = owner === 'ours' && usesGlobalCli && lossless && !hasClonePath;
    return {
      name: spec.name,
      ok,
      status: owner === 'ours' ? (usesGlobalCli && lossless ? 'ok' : 'legacy') : 'foreign',
      path: file,
      usesGlobalCli,
      hasClonePath,
      kind: spec.kind || 'task',
    };
  });
}
