import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from './paths.mjs';

function loadWorkflow(rel) {
  return readFileSync(path.join(packageRoot(), rel), 'utf8').replace(/\r\n/g, '\n');
}

test('ai-issue workflow does not run AI on pull_request events', () => {
  const files = [
    '.github/workflows/ai-issue.yml',
    'examples/github-e2e-test/.github/workflows/ai-issue.yml',
  ];
  for (const rel of files) {
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
    assert.match(y, /default_branch/);
    assert.match(y, /getCollaboratorPermissionLevel/);
    assert.match(y, /'github','authorize'/);
    assert.doesNotMatch(y, /echo \$\{\{ secrets/);
  }
});

test('example CI stays on GitHub-hosted windows-latest not the AI runner', () => {
  const y = loadWorkflow('examples/github-e2e-test/.github/workflows/ci.yml');
  assert.match(y, /windows-latest/);
  assert.doesNotMatch(y, /ai-orchestrator/);
});
