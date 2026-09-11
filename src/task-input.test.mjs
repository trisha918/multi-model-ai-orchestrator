import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTaskArgs, runTask } from './orchestrator.mjs';
import {
  createOwnedTaskFile,
  deleteOwnedTaskFile,
  isOwnedTaskFile,
  resolveTaskInput,
  TaskInputError,
} from './task-input.mjs';
import { workerPrompts, promptContainsExactTask } from './prompts.mjs';
import {
  EXACT_SPECIAL_TASK,
  EXACT_PERSIAN_TASK,
  EXACT_MIXED_TASK,
  EXACT_JSONISH_TASK,
  EXACT_MULTILINE_TASK,
} from './task-fixtures.mjs';
import { packageRoot } from './paths.mjs';
import { resolveTool } from './tooling.mjs';

const cliPath = path.join(packageRoot(), 'bin', 'ai-orchestrator.mjs');

const SAMPLES = [
  EXACT_SPECIAL_TASK,
  EXACT_PERSIAN_TASK,
  EXACT_MIXED_TASK,
  EXACT_JSONISH_TASK,
  EXACT_MULTILINE_TASK,
  'Fix this! Do not break it.',
  'Keep 100% coverage.',
  'Use "hello world" & preserve behavior!',
];

function printTaskViaCli(args, { cwd, input, env } = {}) {
  return spawnSync(process.execPath, [cliPath, 'run', ...args], {
    cwd: cwd || os.tmpdir(),
    encoding: 'utf8',
    input: input ?? undefined,
    env: { ...process.env, ...env, AI_ORCHESTRATOR_PRINT_TASK_AND_EXIT: '1' },
  });
}

test('CLI parser keeps --task bytes including quotes', () => {
  for (const task of SAMPLES) {
    const parsed = parseTaskArgs(['--task', task, '--repo', 'x']);
    assert.equal(parsed.task, task);
    assert.equal(parsed.provided.task, true);
  }
});

test('ambiguous --task and --task-file is rejected', async () => {
  await assert.rejects(
    () => resolveTaskInput(parseTaskArgs(['--task', 'a', '--task-file', 'b.txt'])),
    /Ambiguous task input/,
  );
  await assert.rejects(
    () => resolveTaskInput(parseTaskArgs(['--task', 'a', '--task-stdin'])),
    /Ambiguous task input/,
  );
  await assert.rejects(
    () => resolveTaskInput(parseTaskArgs(['--task-file', 'a.txt', '--task-stdin'])),
    /Ambiguous task input/,
  );
  await assert.rejects(
    () => resolveTaskInput(parseTaskArgs(['--repo', 'x'])),
    /Missing task/,
  );
});

test('--task-file and stdin preserve exact task including spaces in path', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ai orch task-'));
  const file = path.join(parent, 'My Task File.txt');
  try {
    for (const task of SAMPLES) {
      await writeFile(file, task, 'utf8');
      const loaded = await resolveTaskInput(parseTaskArgs(['--task-file', file]));
      assert.equal(loaded, task);

      const viaCli = printTaskViaCli(['--task-file', file], { cwd: parent });
      assert.equal(viaCli.status, 0, viaCli.stderr);
      assert.equal(viaCli.stdout, task);

      const viaStdin = printTaskViaCli(['--task-stdin'], { cwd: parent, input: task });
      assert.equal(viaStdin.status, 0, viaStdin.stderr);
      assert.equal(viaStdin.stdout, task);

      const viaFlag = printTaskViaCli(['--task', task], { cwd: parent });
      assert.equal(viaFlag.status, 0, viaFlag.stderr);
      assert.equal(viaFlag.stdout, task);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('owned task inbox files can be created and deleted only if this invocation created them', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ai orch inbox-'));
  try {
    const created = createOwnedTaskFile(EXACT_SPECIAL_TASK, { tmpRoot });
    assert.equal(isOwnedTaskFile(created, tmpRoot), true);
    assert.equal(await readFile(created, 'utf8'), EXACT_SPECIAL_TASK);
    const outsider = path.join(tmpRoot, 'evil.txt');
    await writeFile(outsider, EXACT_SPECIAL_TASK, 'utf8');
    const denied = deleteOwnedTaskFile(outsider, { createdPath: created, tmpRoot });
    assert.equal(denied.deleted, false);
    assert.equal(existsSync(outsider), true);
    const wrong = deleteOwnedTaskFile(created, { createdPath: outsider, tmpRoot });
    assert.equal(wrong.deleted, false);
    assert.equal(existsSync(created), true);
    const ok = deleteOwnedTaskFile(created, { createdPath: created, tmpRoot });
    assert.equal(ok.deleted, true);
    assert.equal(existsSync(created), false);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('skill transport → CLI → worker prompts keep exact task', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ai orch skill-'));
  try {
    const taskFile = createOwnedTaskFile(EXACT_SPECIAL_TASK, { tmpRoot });
    const loaded = await resolveTaskInput(parseTaskArgs(['--task-file', taskFile]));
    assert.equal(loaded, EXACT_SPECIAL_TASK);
    const prompts = workerPrompts(loaded);
    assert.equal(promptContainsExactTask(prompts.coding, EXACT_SPECIAL_TASK), true);
    assert.equal(promptContainsExactTask(prompts.plan, EXACT_SPECIAL_TASK), true);
    assert.equal(promptContainsExactTask(prompts.review({ worktree: 'C:\\isolated\\worktree' }), EXACT_SPECIAL_TASK), true);
    assert.equal(promptContainsExactTask(prompts.implementation('plan'), EXACT_SPECIAL_TASK), true);
    assert.equal(promptContainsExactTask(prompts.fixHeader, EXACT_SPECIAL_TASK), true);
    assert.equal(promptContainsExactTask(prompts.geminiAnalysis, EXACT_SPECIAL_TASK), true);
    const idx = prompts.coding.indexOf(EXACT_SPECIAL_TASK);
    assert.equal(prompts.coding.slice(idx, idx + EXACT_SPECIAL_TASK.length), EXACT_SPECIAL_TASK);
    deleteOwnedTaskFile(taskFile, { createdPath: taskFile, tmpRoot });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('PowerShell variable → UTF-8 task file → Node CLI is lossless', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai orch ps-'));
  const fixture = path.join(dir, 'fixture.txt');
  const outFile = path.join(dir, 'from-ps.txt');
  await writeFile(fixture, EXACT_SPECIAL_TASK, 'utf8');
  const ps = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const cmd = [
    '$ErrorActionPreference = \'Stop\'',
    `$bytes = [System.IO.File]::ReadAllBytes('${fixture.replace(/'/g, "''")}')`,
    '$task = [System.Text.UTF8Encoding]::new($false).GetString($bytes)',
    `$utf8 = New-Object System.Text.UTF8Encoding $false`,
    `[System.IO.File]::WriteAllText('${outFile.replace(/'/g, "''")}', $task, $utf8)`,
  ].join('; ');
  const r = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const viaCli = printTaskViaCli(['--task-file', outFile], { cwd: dir });
  assert.equal(viaCli.status, 0, viaCli.stderr);
  assert.equal(viaCli.stdout, EXACT_SPECIAL_TASK);
  await rm(dir, { recursive: true, force: true });
});

test('runTask print hook records exact task without workers', async () => {
  let printed = '';
  const code = await runTask(['--task', EXACT_PERSIAN_TASK, '--repo', os.tmpdir()], {
    printTaskAndExit: true, stdout: { write: text => { printed += text; } },
  });
  assert.equal(code, 0);
  assert.equal(printed, EXACT_PERSIAN_TASK);
});

void resolveTool;
void mkdir;
void TaskInputError;
