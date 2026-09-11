import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { TRIGGER_LABEL } from './github-labels.mjs';
import { parseRepoConfigText } from './github-config.mjs';
import { createMemoryGithubClient } from './github-client.mjs';
import { parseGithubCli, githubHelpText, cmdGithub, defaultRunImplementation } from './github-cli.mjs';
import { emptyState, saveIssueState, loadIssueState } from './github-state.mjs';
import { resolveTool } from './tooling.mjs';

const routing = { worker: 'codex', model: 'auto' };

function git(cwd, args) {
  const r = spawnSync(resolveTool('git'), args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || `git ${args.join(' ')} failed`);
  return r.stdout.trim();
}

test('github CLI parsing', () => {
  const run = parseGithubCli(['issue', 'run', '--repo', 'o/r', '--issue', '42', '--dry-run']);
  assert.equal(run.subcommand, 'issue run');
  assert.equal(run.dryRun, true);
  assert.equal(run.issue, '42');
  assert.equal(parseGithubCli(['doctor', '--repo', 'o/r']).subcommand, 'doctor');
  assert.equal(parseGithubCli(['authorize', '--repo', 'o/r', '--issue', '1']).subcommand, 'authorize');
  assert.equal(parseGithubCli(['resume', '--repo', 'o/r', '--issue', '6']).subcommand, 'resume');
  assert.equal(parseGithubCli(['resume', '--repo', 'o/r', '--issue', '6']).issue, '6');
  assert.match(githubHelpText(), /github doctor/);
  assert.match(githubHelpText(), /never auto-merges/);
});

test('simulate fixture command', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-sim-'));
  const file = path.join(dir, 'fx.json');
  const config = parseRepoConfigText(`
automation:
  enabled: true
  mode: assisted
review:
  required: false
`);
  await writeFile(file, JSON.stringify({
    config,
    ciSequence: ['FAIL', 'FAIL', 'PASS'],
    localTests: 'PASS',
    actor: { login: 'm', permission: 'admin' },
    issue: { number: 1, title: 't', labels: [{ name: TRIGGER_LABEL }] },
  }), 'utf8');
  const logs = [];
  try {
    const code = await cmdGithub(parseGithubCli(['simulate', '--fixture', file]), {
      stdout: s => logs.push(s),
      stderr: s => logs.push(s),
    });
    assert.equal(code, 0);
    assert.match(logs.join('\n'), /READY_FOR_HUMAN_MERGE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('labels setup dry-run does not call createLabel', async () => {
  const client = createMemoryGithubClient();
  const orig = client.createLabel;
  let created = 0;
  client.createLabel = async (...args) => {
    created += 1;
    return orig.apply(client, args);
  };
  const logs = [];
  const code = await cmdGithub(parseGithubCli(['labels', 'setup', '--repo', 'o/r', '--dry-run']), {
    clientFactory: async () => client,
    stdout: s => logs.push(s),
    stderr: s => logs.push(s),
  });
  assert.equal(code, 0);
  assert.equal(created, 0);
  assert.match(logs.join('\n'), /ai-auto/);
});

test('github authorize blocks untrusted actors when repo automation is assisted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-authz-'));
  await writeFile(path.join(dir, 'ai-orchestrator.yml'), `automation:
  enabled: true
  mode: assisted
`, 'utf8');
  const ghDir = path.join(dir, '.github');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(ghDir, { recursive: true });
  await writeFile(path.join(ghDir, 'ai-orchestrator.yml'), `automation:
  enabled: true
  mode: assisted
`, 'utf8');
  const client = createMemoryGithubClient({
    issues: {
      3: { number: 3, title: 't', body: '', labels: [{ name: TRIGGER_LABEL }], html_url: '', user: { login: 'r' } },
    },
    events: {
      3: [{ event: 'labeled', label: { name: TRIGGER_LABEL }, actor: { login: 'stranger' }, author_association: 'NONE' }],
    },
    permissions: { stranger: { permission: 'none' } },
  });
  const logs = [];
  try {
    const code = await cmdGithub(parseGithubCli(['authorize', '--repo', 'o/r', '--issue', '3']), {
      clientFactory: async () => client,
      cwd: dir,
      env: { ...process.env, AI_ORCHESTRATOR_RUNTIME_ROOT: dir },
      stdout: s => logs.push(s),
      stderr: s => logs.push(s),
    });
    assert.equal(code, 2);
    assert.match(logs.join('\n'), /untrusted|BLOCKED/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('defaultRunImplementation preserves structured tests and verified branch SHA', async () => {
  const gitArgs = [];
  const impl = await defaultRunImplementation({
    repo: os.tmpdir(),
    branch: 'ai/issue-1-demo',
    task: 'implement',
    routing,
    env: {},
    runTaskImpl: async (_argv, { onResult }) => { onResult({ version: 1, ok: true, tests: 'PASS', review: 'SKIP', commit: 'a'.repeat(40), branch: 'ai/issue-1-demo' }); return 0; },
    gitImpl: async (_repo, args) => {
      gitArgs.push(args);
      return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    },
  });
  assert.equal(impl.ok, true);
  assert.equal(impl.tests, 'PASS');
  assert.equal(impl.commit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.deepEqual(gitArgs[0], ['rev-parse', 'ai/issue-1-demo']);
  assert.notEqual(gitArgs[0]?.[1], 'HEAD');
});

test('defaultRunImplementation does not treat undefined runTask success as ok=true with tests=FAIL', async () => {
  const impl = await defaultRunImplementation({
    repo: os.tmpdir(),
    branch: 'ai/issue-1-demo',
    task: 'implement',
    routing,
    env: {},
    runTaskImpl: async () => undefined,
    gitImpl: async () => 'whatever',
  });
  assert.equal(impl.ok === true && impl.tests === 'FAIL', false);
  assert.equal(impl.ok, false);
  assert.equal(impl.tests, 'UNKNOWN');
});

test('defaultRunImplementation reports FAIL for genuine local-test failures', async () => {
  const impl = await defaultRunImplementation({
    repo: os.tmpdir(),
    branch: 'ai/issue-1-demo',
    task: 'implement',
    routing,
    env: {},
    runTaskImpl: async (_argv, { onResult }) => { onResult({ version: 1, ok: false, tests: 'FAIL', review: 'SKIP', commit: 'a'.repeat(40), branch: 'ai/issue-1-demo' }); return 1; },
    gitImpl: async () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.equal(impl.ok, false);
  assert.equal(impl.tests, 'FAIL');
  assert.equal(impl.commit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('defaultRunImplementation deletes the temp task directory even when runTask throws', async () => {
  const listed = async () => (await readdir(os.tmpdir())).filter(name => name.startsWith('ai-orch-gh-task-'));
  const before = new Set(await listed());
  await assert.rejects(
    () => defaultRunImplementation({
      repo: os.tmpdir(),
      branch: 'ai/issue-1-demo',
      task: 'implement',
      routing,
      env: {},
      runTaskImpl: async () => {
        throw new Error('implementation process terminated');
      },
      gitImpl: async () => 'unused',
    }),
    /process terminated/,
  );
  const leftover = (await listed()).filter(name => !before.has(name));
  assert.deepEqual(leftover, []);
});

test('defaultRunImplementation returns implementation branch SHA, not source HEAD', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-sha-'));
  try {
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    await writeFile(path.join(dir, 'README.md'), 'main\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'main']);
    const mainSha = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', '-b', 'ai/issue-9-impl']);
    await writeFile(path.join(dir, 'impl.txt'), 'worktree commit\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'implementation']);
    const implSha = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', 'main']);
    assert.notEqual(implSha, mainSha);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), mainSha);

    const impl = await defaultRunImplementation({
      repo: dir,
      branch: 'ai/issue-9-impl',
      task: 'implement',
      routing,
      env: {},
      runTaskImpl: async (_argv, { onResult }) => { onResult({ version: 1, ok: true, tests: 'PASS', review: 'SKIP', commit: implSha, branch: 'ai/issue-9-impl' }); return 0; },
    });
    assert.equal(impl.commit, implSha);
    assert.notEqual(impl.commit, mainSha);
    assert.equal(impl.tests, 'PASS');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('github resume from LOCAL_TESTS continues push and PR without re-implementing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-resume-'));
  const env = { ...process.env, AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const implCommit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const implBranch = 'ai/issue-6-add-divide-operation-and-tests';
  await mkdir(path.join(dir, '.github'), { recursive: true });
  await writeFile(path.join(dir, '.github', 'ai-orchestrator.yml'), `automation:
  enabled: true
  mode: assisted
review:
  required: false
`, 'utf8');
  const client = createMemoryGithubClient({
    issues: {
      6: {
        number: 6,
        title: 'Add divide operation and tests',
        body: 'requirements',
        html_url: 'https://github.com/owner/app/issues/6',
        user: { login: 'reporter' },
        labels: [{ name: TRIGGER_LABEL }],
      },
    },
    events: {
      6: [{ event: 'labeled', label: { name: TRIGGER_LABEL }, actor: { login: 'maintainer' }, author_association: 'OWNER' }],
    },
    permissions: { maintainer: { permission: 'admin' } },
    branches: ['main'],
    repo: { default_branch: 'main', private: true },
  });
  let implCalls = 0;
  let pushCalls = 0;
  const logs = [];
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 6, title: 'Add divide operation and tests', html_url: 'https://github.com/owner/app/issues/6' },
      }),
      stage: 'LOCAL_TESTS',
      localTests: 'PASS',
      review: 'PASS',
      commitSha: implCommit,
      branch: implBranch,
      prNumber: null,
      mode: 'assisted',
      maxAttempts: 5,
    }, env);
    const parsed = parseGithubCli(['resume', '--repo', 'owner/app', '--issue', '6']);
    assert.equal(parsed.subcommand, 'resume');
    const code = await cmdGithub(parsed, {
      cwd: dir,
      env,
      clientFactory: async () => client,
      runImplementation: async () => {
        implCalls += 1;
        return { ok: true, tests: 'PASS', commit: 'should-not-replace', branch: 'ai/wrong' };
      },
      gitPush: async ({ branch }) => {
        pushCalls += 1;
        assert.equal(branch, implBranch);
        return { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
      },
      waitForCi: async ({ ref }) => {
        assert.equal(ref, implCommit);
        return { status: 'PENDING', summary: 'GitHub checks not yet reported' };
      },
      stdout: s => logs.push(s),
      stderr: s => logs.push(s),
    });
    assert.equal(code, 0);
    assert.equal(implCalls, 0);
    assert.equal(pushCalls, 1);
    assert.equal(client.log.filter(x => x.op === 'createPullRequest').length, 1);
    const saved = await loadIssueState('owner/app', 6, env);
    assert.equal(saved.commitSha, implCommit);
    assert.equal(saved.branch, implBranch);
    assert.equal(saved.localTests, 'PASS');
    assert.notEqual(saved.stage, 'LOCAL_TESTS');
    assert.equal(saved.stage, 'WAITING_FOR_CI');
    assert.equal(Boolean(saved.prNumber), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('github resume from WAITING_FOR_CI maps Node tests success to READY_FOR_HUMAN_MERGE', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-resume-ci-'));
  const env = { ...process.env, AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const commit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const branch = 'ai/issue-6-add-divide-operation-and-tests';
  await mkdir(path.join(dir, '.github'), { recursive: true });
  await writeFile(path.join(dir, '.github', 'ai-orchestrator.yml'), `automation:
  enabled: true
  mode: assisted
review:
  required: false
`, 'utf8');
  const client = createMemoryGithubClient({
    issues: {
      6: {
        number: 6,
        title: 'Add divide operation and tests',
        body: 'requirements',
        html_url: 'https://github.com/owner/app/issues/6',
        user: { login: 'reporter' },
        labels: [{ name: TRIGGER_LABEL }],
      },
    },
    events: {
      6: [{ event: 'labeled', label: { name: TRIGGER_LABEL }, actor: { login: 'maintainer' }, author_association: 'OWNER' }],
    },
    permissions: { maintainer: { permission: 'admin' } },
    branches: ['main'],
    repo: { default_branch: 'main', private: true },
    pulls: [{ number: 7, head: { ref: branch, sha: commit }, body: 'Closes #6', issueNumber: 6 }],
  });
  client.getChecks = async () => ({
    total_count: 1,
    check_runs: [{ name: 'Node tests', status: 'completed', conclusion: 'success' }],
  });
  const logs = [];
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 6, title: 'Add divide operation and tests', html_url: 'https://github.com/owner/app/issues/6' },
      }),
      stage: 'WAITING_FOR_CI',
      prNumber: 7,
      githubCi: 'UNKNOWN',
      localTests: 'PASS',
      review: 'PASS',
      commitSha: commit,
      branch,
      mode: 'assisted',
      maxAttempts: 5,
    }, env);
    const code = await cmdGithub(parseGithubCli(['resume', '--repo', 'owner/app', '--issue', '6']), {
      cwd: dir,
      env,
      clientFactory: async () => client,
      runImplementation: async () => {
        throw new Error('must not re-implement while waiting for CI');
      },
      gitPush: async () => {
        throw new Error('must not push while waiting for CI');
      },
      waitForCi: async () => {
        throw new Error('resume CI sync should use GitHub checks, not the live waiter');
      },
      stdout: s => logs.push(s),
      stderr: s => logs.push(s),
    });
    assert.equal(code, 0);
    const saved = await loadIssueState('owner/app', 6, env);
    assert.equal(saved.githubCi, 'PASS');
    assert.equal(saved.stage, 'READY_FOR_HUMAN_MERGE');
    assert.match(logs.join('\n'), /READY_FOR_HUMAN_MERGE|PASS/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('github resume updates state file even when cwd automation yaml is disabled', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-orch-gh-resume-disabled-'));
  const env = { ...process.env, AI_ORCHESTRATOR_RUNTIME_ROOT: dir };
  const commit = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';
  const branch = 'ai/issue-6-add-divide-operation-and-tests';
  await mkdir(path.join(dir, '.github'), { recursive: true });
  await writeFile(path.join(dir, '.github', 'ai-orchestrator.yml'), `automation:
  enabled: false
  mode: manual
`, 'utf8');
  const client = createMemoryGithubClient({
    issues: {
      6: {
        number: 6,
        title: 'Add divide operation and tests',
        body: 'requirements',
        html_url: 'https://github.com/owner/app/issues/6',
        user: { login: 'reporter' },
        labels: [{ name: TRIGGER_LABEL }],
      },
    },
    events: {
      6: [{ event: 'labeled', label: { name: TRIGGER_LABEL }, actor: { login: 'maintainer' }, author_association: 'OWNER' }],
    },
    permissions: { maintainer: { permission: 'admin' } },
    branches: ['main'],
    repo: { default_branch: 'main', private: true },
    pulls: [{ number: 7, head: { ref: branch, sha: commit }, body: 'Closes #6', issueNumber: 6 }],
  });
  client.getChecks = async () => ({
    total_count: 1,
    check_runs: [{ name: 'Node tests', status: 'completed', conclusion: 'success' }],
  });
  const logs = [];
  try {
    await saveIssueState({
      ...emptyState({
        repo: 'owner/app',
        issue: { number: 6, title: 'Add divide operation and tests', html_url: 'https://github.com/owner/app/issues/6' },
      }),
      stage: 'WAITING_FOR_CI',
      prNumber: 7,
      githubCi: 'UNKNOWN',
      localTests: 'PASS',
      review: 'PASS',
      commitSha: commit,
      branch,
      mode: 'assisted',
      maxAttempts: 5,
    }, env);
    const code = await cmdGithub(parseGithubCli(['resume', '--repo', 'owner/app', '--issue', '6']), {
      cwd: dir,
      env,
      clientFactory: async () => client,
      runImplementation: async () => {
        throw new Error('must not re-implement while waiting for CI');
      },
      gitPush: async () => {
        throw new Error('must not push while waiting for CI');
      },
      waitForCi: async () => {
        throw new Error('resume CI sync should use GitHub checks, not the live waiter');
      },
      stdout: s => logs.push(s),
      stderr: s => logs.push(s),
    });
    assert.equal(code, 0);
    assert.doesNotMatch(logs.join('\n'), /automation disabled/);
    const saved = await loadIssueState('owner/app', 6, env);
    assert.equal(saved.githubCi, 'PASS');
    assert.equal(saved.stage, 'READY_FOR_HUMAN_MERGE');
    assert.match(logs.join('\n'), /READY_FOR_HUMAN_MERGE/);
    assert.match(logs.join('\n'), /PASS/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
