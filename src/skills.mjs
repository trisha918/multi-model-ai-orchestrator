import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { cursorSkillsRoot } from './paths.mjs';

export const SKILL_OWNER = 'multi-model-ai-orchestrator';

const SKILLS = [
  {
    name: 'ai',
    mode: 'auto',
    description: 'Run the local multi-model AI orchestrator. It automatically routes work among Cursor Agent models, Codex, and Gemini/Antigravity.',
  },
  {
    name: 'ai-team',
    mode: 'team',
    description: 'Run the multi-agent team workflow: Cursor Agent plans, Codex implements, and Gemini/Antigravity reviews with an auto-fix loop.',
  },
];

export function skillMarkdown({ name, mode, description }) {
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

\`& ai-orchestrator @('run','--repo',$gitRoot,'--mode','${mode}','--commit-on-pass','--task-file',$taskFile)\`

7. After the CLI returns, delete only that same inbox file if it is the file this invocation created. Do not delete other files. Do not add \`--in-place\`.
8. Wait for the process to finish. Then report the Route banner (CURSOR, CODEX, GEMINI, or TEAM), each stage result, branch/worktree, commit hash if any, and run-log path.
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
  return /(?:^|[^A-Za-z0-9_-])ai-orchestrator(?![A-Za-z0-9_-])/.test(text)
    && /ai-orchestrator[\s\S]{0,160}run/.test(text);
}

export function skillUsesLosslessTaskTransport(content) {
  const text = String(content || '');
  return /--task-file/.test(text) && !/'--task',\s*\$task/.test(text);
}

export function skillContainsClonePath(content) {
  return /[A-Za-z]:\\/.test(content) || /\/(?:Users|home)\//.test(content);
}

export function skillPath(name, env = process.env) {
  return path.join(cursorSkillsRoot(env), name, 'SKILL.md');
}

export async function installSkills({ env = process.env, force = false } = {}) {
  const results = [];
  for (const spec of SKILLS) {
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
  return results;
}

export async function uninstallSkills({ env = process.env } = {}) {
  const results = [];
  for (const spec of SKILLS) {
    const file = skillPath(spec.name, env);
    const dir = path.dirname(file);
    if (!existsSync(file)) {
      results.push({ name: spec.name, status: 'missing', path: file });
      continue;
    }
    const existing = readFileSync(file, 'utf8');
    if (classifySkillContent(existing) !== 'ours') {
      results.push({
        name: spec.name,
        status: 'skipped-foreign',
        path: file,
        message: `Existing /${spec.name} skill is not owned by this project. It was left unchanged.`,
      });
      continue;
    }
    await rm(dir, { recursive: true, force: true });
    results.push({ name: spec.name, status: 'removed', path: file });
  }
  return results;
}

export function skillStatus(env = process.env) {
  return SKILLS.map(spec => {
    const file = skillPath(spec.name, env);
    if (!existsSync(file)) return { name: spec.name, ok: false, status: 'missing', path: file };
    const content = readFileSync(file, 'utf8');
    const owner = classifySkillContent(content);
    const usesGlobalCli = skillUsesGlobalCli(content);
    const lossless = skillUsesLosslessTaskTransport(content);
    const hasClonePath = skillContainsClonePath(content);
    return {
      name: spec.name,
      ok: owner === 'ours' && usesGlobalCli && lossless && !hasClonePath,
      status: owner === 'ours' ? (usesGlobalCli && lossless ? 'ok' : 'legacy') : 'foreign',
      path: file,
      usesGlobalCli,
      hasClonePath,
    };
  });
}
