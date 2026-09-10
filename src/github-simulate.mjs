import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryGithubClient } from './github-client.mjs';
import { parseRepoConfigText, validateRepoConfig } from './github-config.mjs';
import { TRIGGER_LABEL } from './github-labels.mjs';
import { runIssueAutomation } from './github-automation.mjs';
import { emptyState, saveIssueState, loadIssueState, parseRepoSlug } from './github-state.mjs';
import { CI_STATUS } from './github-ci.mjs';

const DEFAULT_COMMIT = '2d1d7a07bb537b06f07f1afa8aea2b580064a09f';

export function resolveSimulateConfig(raw) {
  if (raw == null) {
    return validateRepoConfig({
      automation: { enabled: true, mode: 'assisted', max_fix_attempts: 5 },
      review: { required: false },
      tests: { required: true },
    });
  }
  if (typeof raw === 'string') return parseRepoConfigText(raw);
  return validateRepoConfig({
    automation: raw.automation,
    pull_request: raw.pull_request,
    tests: raw.tests,
    review: raw.review,
    publish: raw.publish,
  });
}

export function normalizeCiStatus(value) {
  if (value && typeof value === 'object') {
    return normalizeCiStatus(value.status || value.githubCi);
  }
  const s = String(value || 'PASS').trim().toUpperCase();
  if (s === 'TIMEOUT') return CI_STATUS.TIMEOUT;
  if (s === 'PENDING') return CI_STATUS.PENDING;
  if (s === 'FAIL' || s === 'FAILED' || s === 'FAILURE') return CI_STATUS.FAIL;
  return CI_STATUS.PASS;
}

export function normalizeCiSequence(fixture = {}) {
  if (Array.isArray(fixture.ciSequence) && fixture.ciSequence.length) {
    return fixture.ciSequence.map(normalizeCiStatus);
  }
  if (Array.isArray(fixture.ci) && fixture.ci.length) {
    return fixture.ci.map(normalizeCiStatus);
  }
  if (fixture.ci != null) return [normalizeCiStatus(fixture.ci)];
  return [CI_STATUS.PASS];
}

function asLabels(labels) {
  if (!labels || !labels.length) return [{ name: TRIGGER_LABEL }];
  return labels.map(l => (typeof l === 'string' ? { name: l } : { name: l?.name || TRIGGER_LABEL }));
}

function normalizeIssue(fixture = {}) {
  const issue = fixture.issue || {};
  const number = Number(issue.number || fixture.issueNumber || 1);
  return {
    number,
    title: issue.title || fixture.title || 'Simulated issue',
    body: issue.body || fixture.body || 'Simulated requirements.',
    html_url: issue.html_url || `https://github.com/${fixture.repo || 'owner/app'}/issues/${number}`,
    user: issue.user || { login: 'reporter' },
    labels: asLabels(issue.labels),
  };
}

function countActions(actions, type) {
  return actions.filter(a => a.type === type).length;
}

/**
 * Offline GitHub automation lifecycle simulator.
 * Reuses runIssueAutomation + an in-memory GitHub/git/CI client. No network.
 */
export async function runGithubLifecycleSimulator(fixture = {}, { env } = {}) {
  const config = resolveSimulateConfig(fixture.config);
  const repo = fixture.repo || 'owner/app';
  const { owner, name, slug } = parseRepoSlug(repo);
  const issue = normalizeIssue({ ...fixture, repo: slug });
  const actor = {
    login: fixture.actor?.login || 'maintainer',
    permission: fixture.actor?.permission || 'admin',
    association: fixture.actor?.association || 'OWNER',
  };
  const runtime = env?.AI_ORCHESTRATOR_RUNTIME_ROOT
    ? env
    : { AI_ORCHESTRATOR_RUNTIME_ROOT: await mkdtemp(path.join(os.tmpdir(), 'ai-orch-sim-life-')) };
  const commit = fixture.implementationCommit || fixture.commitSha || DEFAULT_COMMIT;
  const presetBranch = fixture.branch || fixture.existingState?.branch || '';
  const remoteBranches = { ...(fixture.remoteBranches || {}) };
  const pulls = [...(fixture.pulls || [])];
  if (fixture.existingPr) {
    const pr = fixture.existingPr;
    const prNumber = typeof pr === 'number' ? pr : pr.number;
    const headRef = (typeof pr === 'object' && (pr.head?.ref || pr.branch || pr.head)) || presetBranch || `ai/issue-${issue.number}-simulated`;
    const headSha = (typeof pr === 'object' && (pr.head?.sha || pr.sha)) || commit;
    pulls.push({
      number: prNumber,
      head: { ref: headRef, sha: headSha },
      body: (typeof pr === 'object' && pr.body) || `Closes #${issue.number}`,
      issueNumber: issue.number,
    });
  }

  const client = createMemoryGithubClient({
    issues: { [issue.number]: issue },
    events: {
      [issue.number]: [{
        event: 'labeled',
        label: { name: config.automation.trigger_label || TRIGGER_LABEL },
        actor: { login: actor.login },
        author_association: actor.association,
      }],
    },
    permissions: { [actor.login]: { permission: actor.permission } },
    branches: fixture.branches || ['main'],
    repo: { default_branch: fixture.defaultBranch || 'main', private: true },
    remoteBranches,
    pulls,
    checks: fixture.checks || {},
  });

  const actions = [];
  const originalCreate = client.createPullRequest.bind(client);
  client.createPullRequest = async (o, n, payload) => {
    actions.push({ type: 'createPR', head: payload.head, title: payload.title });
    return originalCreate(o, n, payload);
  };

  if (fixture.existingState) {
    const base = emptyState({ repo: slug, issue });
    await saveIssueState({
      ...base,
      ...fixture.existingState,
      repository: slug,
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueUrl: issue.html_url,
      mode: fixture.existingState.mode || config.automation.mode,
    }, runtime);
  }

  const ciQueue = normalizeCiSequence(fixture);
  const localQueue = Array.isArray(fixture.localTests) ? [...fixture.localTests] : null;
  let pushAttempts = 0;
  let implementCount = 0;

  function shaForImplement(n) {
    if (n <= 1) return fixture.implementationCommit || commit;
    const suffix = n.toString(16).padStart(2, '0');
    return `${commit.slice(0, -2)}${suffix}`;
  }

  async function runImplementation({ branch, task }) {
    implementCount += 1;
    const tests = localQueue ? (localQueue.shift() || 'PASS') : (fixture.localTests || 'PASS');
    const ok = tests === 'PASS' || tests === 'SKIP';
    const sha = shaForImplement(implementCount);
    actions.push({
      type: 'implement',
      branch,
      tests,
      commit: sha,
      fix: /GitHub CI|fix requested|previousAttempts/i.test(String(task || '')),
    });
    return {
      ok,
      tests,
      review: fixture.review || 'PASS',
      commit: sha,
      branch,
      route: 'CODEX',
      model: 'auto',
    };
  }

  async function gitPush({ branch, force }) {
    pushAttempts += 1;
    actions.push({ type: 'push', branch, force: Boolean(force) });
    if (fixture.crashOnPush && pushAttempts === 1) {
      throw new Error('simulated crash during push');
    }
    const lastImpl = actions.filter(a => a.type === 'implement').at(-1);
    const sha = lastImpl?.commit || commit;
    remoteBranches[branch] = sha;
    return { sha };
  }

  async function waitForCi() {
    const status = ciQueue.length ? ciQueue.shift() : CI_STATUS.PASS;
    actions.push({ type: 'waitCi', status });
    return { status, summary: `simulated ${status}` };
  }

  async function once() {
    return runIssueAutomation({
      client,
      config,
      repo: slug,
      issueNumber: issue.number,
      env: runtime,
      localRepo: fixture.localRepo || os.tmpdir(),
      runImplementation,
      gitPush,
      waitForCi,
      defaultBranch: fixture.defaultBranch || 'main',
    });
  }

  const runs = [];
  const first = await once();
  runs.push(summarizeRun(first));

  if (fixture.resumeAfterCrash && first.crashed) {
    const saved = await loadIssueState(slug, issue.number, runtime);
    if (saved?.branch && saved.commitSha) {
      remoteBranches[saved.branch] = saved.commitSha;
    }
    const second = await once();
    runs.push(summarizeRun(second));
  } else if (fixture.duplicateRun) {
    const second = await once();
    runs.push(summarizeRun(second));
  }

  const last = runs[runs.length - 1];
  const state = last.state;
  const merged = Boolean(state?.pullRequestAutoMerged);
  const published = Boolean(state?.published);
  return {
    ok: last.code === 0 && state?.stage === 'READY_FOR_HUMAN_MERGE' && !merged && !published,
    scenario: fixture.scenario || 'custom',
    state,
    decision: last.decision,
    actions,
    runs,
    client,
    counts: {
      implement: countActions(actions, 'implement'),
      push: countActions(actions, 'push'),
      createPR: countActions(actions, 'createPR'),
      waitCi: countActions(actions, 'waitCi'),
    },
    env: runtime,
  };
}

function summarizeRun(result) {
  return {
    code: result.code,
    stage: result.state?.stage,
    skipped: Boolean(result.skipped),
    crashed: Boolean(result.crashed),
    needsConfirmation: Boolean(result.needsConfirmation),
    waiting: Boolean(result.waiting),
    decision: result.decision,
    state: result.state,
  };
}

export function formatSimulateResult(result) {
  return JSON.stringify({
    scenario: result.scenario,
    stage: result.state?.stage,
    attempt: result.state?.attempt,
    max: result.state?.maxAttempts,
    prNumber: result.state?.prNumber || null,
    ok: result.ok,
    counts: result.counts,
    actions: result.actions,
    runs: result.runs.map(r => ({
      code: r.code,
      stage: r.stage,
      skipped: r.skipped,
      crashed: r.crashed,
      decision: r.decision?.action,
    })),
    pullRequestAutoMerged: Boolean(result.state?.pullRequestAutoMerged),
    published: Boolean(result.state?.published),
  }, null, 2);
}
