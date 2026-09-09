import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCli, printVersion, helpText } from './cli.mjs';
import { parseTaskArgs } from './orchestrator.mjs';
import { VERSION } from './tooling.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageRoot } from './paths.mjs';
import { resolveTool } from './tooling.mjs';

const cliPath = path.join(packageRoot(), 'bin', 'ai-orchestrator.mjs');

function runCli(args, { cwd } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: cwd || os.tmpdir(),
    encoding: 'utf8',
    env: process.env,
  });
}

test('CLI version command and flags', () => {
  assert.equal(parseCli(['version']).command, 'version');
  assert.equal(parseCli(['--version']).command, 'version');
  assert.equal(parseCli(['-v']).command, 'version');
  assert.equal(printVersion(), `Multi-Model AI Orchestrator v${VERSION}`);
  assert.match(helpText(), /ai-orchestrator/);
});

test('CLI command parsing', () => {
  assert.equal(parseCli(['doctor']).command, 'doctor');
  assert.equal(parseCli(['cleanup', '--apply']).command, 'cleanup');
  assert.equal(parseCli(['config', 'show']).subcommand, 'show');
  assert.equal(parseCli(['config', 'path']).subcommand, 'path');
  assert.equal(parseCli(['config', 'set', 'defaultMode', 'auto']).key, 'defaultMode');
  assert.equal(parseCli(['install-skills']).command, 'install-skills');
  assert.equal(parseCli(['uninstall-skills']).command, 'uninstall-skills');
  assert.equal(parseCli(['nope']).command, 'unknown');
  const run = parseCli(['run', '--repo', 'C:\\Projects\\My App', '--mode', 'auto', '--task', 'Fix it']);
  assert.equal(run.command, 'run');
  assert.equal(run.taskArgs.repo, 'C:\\Projects\\My App');
  assert.equal(run.taskArgs.task, 'Fix it');
  const collapsed = parseCli(['run --repo C:\\x --task y']);
  assert.equal(collapsed.command, 'unknown');
  assert.match(collapsed.error, /collapsed into a single string/);
});

test('special-character preservation through global CLI parser', () => {
  const task = `Fix this! Use "quotes" & don't break | < > % ^`;
  const parsed = parseCli(['run', '--repo', '/tmp/repo', '--task', task, '--mode', 'cursor']);
  assert.equal(parsed.taskArgs.task, task);
  const args = parseTaskArgs(['--task', task, '--repo', 'x']);
  assert.equal(args.task, task);
});

test('global CLI version works outside repository cwd', () => {
  const r = runCli(['version'], { cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /Multi-Model AI Orchestrator v0\.9\.0/);
});

test('global CLI doctor works outside repository cwd', () => {
  const r = runCli(['doctor'], { cwd: os.tmpdir() });
  const blob = `${r.stdout}\n${r.stderr}`;
  assert.match(blob, /Multi-Model AI Orchestrator/);
  assert.match(blob, /Config:/);
  assert.match(blob, /Runtime:/);
});

test('CLI config path works outside repository cwd', () => {
  const r = runCli(['config', 'path'], { cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /MultiModelAIOrchestrator/);
});

test('CLI run resolves a repo path that contains spaces and does not use packageRoot', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ai orch space-'));
  const repo = path.join(parent, 'My App');
  await mkdir(repo, { recursive: true });
  const gitExe = resolveTool('git');
  const git = (args, cwd = repo) => {
    const r = spawnSync(gitExe, args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  };
  try {
    git(['init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    const r = runCli(['run', '--repo', repo, '--mode', 'cursor', '--task', 'x'], { cwd: os.tmpdir() });
    const blob = `${r.stdout}\n${r.stderr}`;
    assert.match(blob, /no commits|invalid HEAD|not a Git repository/);
    assert.ok(!blob.includes(packageRoot()) || blob.includes(repo));
    assert.notEqual(path.resolve(repo), path.resolve(packageRoot()));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void fileURLToPath;
