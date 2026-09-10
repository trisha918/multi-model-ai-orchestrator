import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCli } from './cli.mjs';
import { packageRoot } from './paths.mjs';

function loadWorkflow(rel) {
  return readFileSync(path.join(packageRoot(), rel), 'utf8').replace(/\r\n/g, '\n');
}

const aiIssueWorkflows = [
  '.github/workflows/ai-issue.yml',
  'examples/github-e2e-test/.github/workflows/ai-issue.yml',
];

test('ai-issue workflow does not run AI on pull_request events', () => {
  for (const rel of aiIssueWorkflows) {
    const y = loadWorkflow(rel);
    assert.match(y, /issues:\s*\n\s*types:\s*\[labeled\]/);
    assert.doesNotMatch(y, /pull_request_target/);
    assert.doesNotMatch(y, /on:\s*\n(?:.*\n)*\s*pull_request:/);
    assert.match(y, /github\.event\.label\.name == 'ai-auto'/);
    assert.match(y, /ai-issue-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.issue\.number/);
    assert.match(y, /\[self-hosted, Windows, ai-orchestrator\]/);
    assert.match(y, /needs: authorize/);
    assert.match(y, /needs\.authorize\.outputs\.allowed == 'true'/);
    assert.match(y, /runs-on: ubuntu-latest/);
    assert.match(y, /secrets\.GITHUB_TOKEN/);
    assert.match(y, /checks: read/);
    assert.match(y, /default_branch/);
    assert.match(y, /getCollaboratorPermissionLevel/);
    assert.match(y, /node\.exe \$entry @\('github','authorize'/);
    assert.match(y, /node\.exe \$entry @\('github','issue','run'/);
    assert.doesNotMatch(y, /(?:^|\n)\s*ai-orchestrator @\(/);
    assert.doesNotMatch(y, /echo \$\{\{ secrets/);
  }
});

test('github authorize CLI args stay separate for the Windows runner invocation', () => {
  const argv = ['github', 'authorize', '--repo', 'owner/name', '--issue', '1'];
  const parsed = parseCli(argv);
  assert.equal(parsed.command, 'github');
  assert.equal(parsed.github.subcommand, 'authorize');
  assert.equal(parsed.github.repo, 'owner/name');
  assert.equal(parsed.github.issue, '1');

  const collapsed = parseCli(['github authorize --repo owner/name --issue 1']);
  assert.equal(collapsed.command, 'unknown');
  assert.match(collapsed.error, /Unknown command: github authorize/);

  const cliPath = path.join(packageRoot(), 'bin', 'ai-orchestrator.mjs');
  const r = spawnSync(process.execPath, [cliPath, ...argv], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '' },
    timeout: 20_000,
  });
  const blob = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert.doesNotMatch(blob, /Unknown command: github authorize/);
  assert.notEqual(parsed.github.subcommand, 'github authorize --repo owner/name --issue 1');

  if (process.platform === 'win32') {
    const ps = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `& node.exe ${JSON.stringify(cliPath)} @('github','authorize','--repo','owner/name','--issue','1')`,
    ], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '' },
      timeout: 20_000,
    });
    const psBlob = `${ps.stdout || ''}\n${ps.stderr || ''}`;
    assert.equal(ps.error, undefined, ps.error?.message || psBlob);
    assert.doesNotMatch(psBlob, /Unknown command: github authorize/);
  }
});

test('example CI stays on GitHub-hosted windows-latest not the AI runner', () => {
  const y = loadWorkflow('examples/github-e2e-test/.github/workflows/ci.yml');
  assert.match(y, /windows-latest/);
  assert.doesNotMatch(y, /ai-orchestrator/);
});
