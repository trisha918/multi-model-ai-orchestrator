import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isIssueAutomationActive } from './github-config.mjs';
import { TRIGGER_LABEL, STOP_LABEL, resolveIssueRouting, RoutingConflictError, statusLabelForStage, reconcileStatusLabels, labelDiff } from './github-labels.mjs';
import { authorizeAiAutoTrigger, extractLabelEventActor, BLOCK_UNTRUSTED } from './github-auth.mjs';
import { buildIssueTaskContext } from './github-task.mjs';
import { proposeBranchName, assertSafePushBranch, prTitleForIssue, prBodyForIssue, formatStatusComment, formatGithubStatus, MILESTONE_HEADLINES } from './github-pr.mjs';
import { classifyCheckRuns, CI_STATUS, collectCiFailureContext, redactCiText, fetchGithubCiRuns } from './github-ci.mjs';
import {
  parseRepoSlug,
  emptyState,
  loadIssueState,
  saveIssueState,
  acquireIssueLock,
  releaseIssueLock,
  applyStage,
  transitionStage,
  isSettledStage,
  COMPLETE_STAGES,
  STOPPED_STAGES,
} from './github-state.mjs';
import { runtimeDirs } from './paths.mjs';
import { createGithubEventLog, issueEventsPath } from './github-events.mjs';

export { CI_STATUS };
export { isAllowedTransition, transitionStage, applyStage, ALLOWED_TRANSITIONS } from './github-state.mjs';

export function recordCiResult(state, status) {
  if (isSettledStage(state?.stage)) {
    return { ...state };
  }
  const attempt = (state.ciAttempts || 0) + 1;
  const max = state.maxAttempts || 5;
  const next = {
    ...state,
    ciAttempts: attempt,
    attempt,
    githubCi: status,
    lastCiRun: status,
  };
  let dest = 'FIXING';
  if (status === CI_STATUS.PASS) {
    next.lastFailure = '';
    dest = 'READY_FOR_HUMAN_MERGE';
  } else if (attempt >= max) {
    next.lastFailure = status;
    dest = 'HUMAN_REVIEW_REQUIRED';
  } else {
    next.aiFixRound = (state.aiFixRound || 0) + 1;
    next.lastFailure = status;
    dest = 'FIXING';
  }
  const moved = transitionStage(next, dest, { onIllegal: 'noop' });
  if (moved.transitionApplied === false && (state.stage || 'IDLE') !== dest) {
    return { ...state };
  }
  delete moved.transitionApplied;
  return moved;
}

function hasExistingAutomation(existingState) {
  const stage = existingState?.stage;
  return Boolean(existingState && stage && stage !== 'IDLE');
}

export function decideTrigger({
  config,
  labels = [],
  authorization,
  existingState,
  lockHeld = false,
} = {}) {
  const names = labels.map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
  if (names.includes(STOP_LABEL)) {
    return { action: 'cancel', reason: 'ai-stop label present' };
  }
  // Resume an in-progress issue even when cwd yaml is disabled/manual.
  // `github resume --repo owner/name` is often run from another checkout
  // (including this product repo, whose automation is off by default).
  if (!hasExistingAutomation(existingState)) {
    if (!isIssueAutomationActive(config)) {
      const mode = config?.automation?.mode || 'manual';
      const enabled = Boolean(config?.automation?.enabled);
      if (!enabled) return { action: 'skip', reason: 'automation disabled' };
      return { action: 'skip', reason: `${mode} mode` };
    }
    if (!names.includes(config.automation.trigger_label || TRIGGER_LABEL)) {
      return { action: 'skip', reason: 'trigger label absent' };
    }
  }
  const stage = existingState?.stage;
  if (COMPLETE_STAGES.includes(stage)) {
    return { action: 'already-complete', reason: stage, state: existingState };
  }
  if (STOPPED_STAGES.includes(stage) && !(stage === 'HUMAN_REVIEW_REQUIRED' && existingState?.unsafePushPending)) {
    return { action: 'already-stopped', reason: stage, state: existingState };
  }
  if (!authorization?.ok) {
    return { action: 'block', reason: authorization?.reason || BLOCK_UNTRUSTED };
  }
  if (lockHeld) {
    return { action: 'busy', reason: 'concurrency lock held' };
  }
  if (stage === 'HUMAN_REVIEW_REQUIRED' && existingState?.unsafePushPending) {
    return { action: 'resume', reason: 'unsafe-push-pending', state: existingState };
  }
  if (existingState && stage && stage !== 'IDLE') {
    return { action: 'resume', reason: stage, state: existingState };
  }
  return { action: 'start', reason: 'trusted ai-auto' };
}

export async function readGithubCiStatus({ client, owner, name, state, config }) {
  let ref = state?.commitSha || state?.branch || '';
  if (state?.prNumber && typeof client.getPullRequest === 'function') {
    try {
      const pr = await client.getPullRequest(owner, name, state.prNumber);
      ref = pr?.head?.sha || ref;
    } catch {
      /* use commit/branch already on state */
    }
  }
  const runs = await fetchGithubCiRuns(client, owner, name, ref);
  const classified = classifyCheckRuns(runs, { now: Date.now() });
  if (classified.status === CI_STATUS.PASS) {
    if (!config) return { githubCi: 'PASS', stage: 'READY_FOR_HUMAN_MERGE', summary: classified.summary || '' };
    const testsOk = config?.tests?.required ? state?.localTests === 'PASS' : ['PASS', 'SKIP'].includes(state?.localTests);
    const reviewOk = config?.review?.required ? state?.review === 'PASS' : ['PASS', 'SKIP'].includes(state?.review);
    return { githubCi: 'PASS', stage: testsOk && reviewOk ? 'READY_FOR_HUMAN_MERGE' : 'HUMAN_REVIEW_REQUIRED', summary: classified.summary || '' };
  }
  if (classified.status === CI_STATUS.FAIL) {
    return { githubCi: 'FAIL', stage: 'FIXING', summary: classified.summary || '' };
  }
  return { githubCi: 'PENDING', stage: 'WAITING_FOR_CI', summary: classified.summary || '' };
}

function dryLog(plan, message, extra = {}) {
  plan.steps.push({ message, ...extra, write: false });
}

function applyImplementationResult(state, result, config) {
  state.localTests = result?.tests || 'UNKNOWN';
  state.review = result?.review || (config.review.required ? 'UNKNOWN' : 'SKIP');
  if (result?.commit) state.commitSha = result.commit;
  if (result?.route) state.route = result.route;
  if (result?.model) state.model = result.model;
  if (result?.branch) state.branch = result.branch;
  state.branchPushed = false;
}

export async function shouldSkipGitPush({ client, owner, name, state, ignoreExistingPr = false } = {}) {
  if (state?.prNumber && !ignoreExistingPr) return { skip: true, reason: 'pr-exists' };
  if (state?.branchPushed && state.commitSha && !state.unsafePushPending) {
    return { skip: true, reason: 'branch-already-pushed' };
  }
  if (typeof client?.getBranch === 'function' && state?.branch && state?.commitSha) {
    try {
      const remote = await client.getBranch(owner, name, state.branch);
      const sha = remoteCommitSha(remote);
      if (sha && commitShasMatch(sha, state.commitSha)) {
        return { skip: true, reason: 'remote-sha-matches' };
      }
    } catch {
      /* fall through to push */
    }
  }
  return { skip: false, reason: '' };
}

function rememberPushedSha(state, pushed) {
  if (state.commitSha) return;
  if (pushed?.sha) state.commitSha = pushed.sha;
}

export function commitShasMatch(left, right) {
  const a = String(left || '').trim().toLowerCase();
  const b = String(right || '').trim().toLowerCase();
  return Boolean(a && b && a === b);
}

function remoteCommitSha(branchInfo) {
  return String(branchInfo?.commit?.sha || branchInfo?.sha || '').trim();
}

export async function reconcileUnsafePushPending({ client, owner, name, state }) {
  const branch = String(state?.branch || '').trim();
  const expected = String(state?.commitSha || '').trim();
  if (!branch || !expected) {
    return {
      action: 'human',
      reason: 'Crash recovery: a push may have been interrupted, but branch or commit SHA is missing. Human confirmation required before pushing again.',
    };
  }
  if (typeof client.getBranch !== 'function') {
    return {
      action: 'human',
      reason: 'Crash recovery: cannot inspect the remote branch. Human confirmation required before pushing again.',
    };
  }
  let remote = null;
  try {
    remote = await client.getBranch(owner, name, branch);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/\b404\b/.test(msg)) {
      return {
        action: 'human',
        reason: `Crash recovery: failed to inspect remote branch ${branch}. Human confirmation required before pushing again.`,
      };
    }
  }
  const remoteSha = remoteCommitSha(remote);
  if (!remoteSha) {
    return {
      action: 'human',
      reason: `Crash recovery: remote branch ${branch} was not found. Human confirmation required before pushing again.`,
    };
  }
  if (!commitShasMatch(remoteSha, expected)) {
    return {
      action: 'human',
      reason: `Crash recovery: remote ${branch} is ${remoteSha} but expected ${expected}. Refusing to force-push.`,
    };
  }
  return { action: 'reconciled', branch, sha: remoteSha };
}

export async function simulateGithubAutomation(fixture = {}) {
  const issue = fixture.issue || { number: 1, title: 'task', body: '', labels: [{ name: TRIGGER_LABEL }] };
  const config = fixture.config;
  const labels = issue.labels || [];
  const authorization = authorizeAiAutoTrigger({
    triggerLabelPresent: true,
    actorLogin: fixture.actor?.login || 'maintainer',
    permission: fixture.actor?.permission || 'admin',
    association: fixture.actor?.association,
    allowedUsers: config?.automation?.allowed_actors,
  });
  const decision = decideTrigger({ config, labels, authorization, existingState: fixture.existingState });
  if (decision.action !== 'start' && decision.action !== 'resume') {
    return {
      ok: decision.action !== 'block',
      blocked: decision.action === 'block',
      decision,
      state: fixture.existingState || emptyState({ repo: fixture.repo, issue }),
    };
  }

  let state = fixture.existingState || emptyState({ repo: fixture.repo || 'owner/app', issue });
  state.mode = config.automation.mode;
  state.maxAttempts = config.automation.max_fix_attempts;
  if (decision.action !== 'resume' || state.stage === 'IDLE' || state.stage === 'STARTED') {
    applyStage(state, 'WORKING');
  }
  state.implementationAttempt = 1;
  state.localTests = fixture.localTests || 'PASS';
  state.route = fixture.route || 'CODEX';
  state.model = fixture.model || 'auto';
  if (state.localTests !== 'PASS' && state.localTests !== 'SKIP') {
    applyStage(state, 'FAILED');
    return { ok: false, state, decision };
  }

  const sequence = fixture.ciSequence || [CI_STATUS.PASS];
  for (const status of sequence) {
    applyStage(state, 'WAITING_FOR_CI');
    state = recordCiResult(state, status);
    if (state.stage === 'READY_FOR_HUMAN_MERGE') break;
    if (state.stage === 'HUMAN_REVIEW_REQUIRED') break;
    if (state.stage === 'FIXING') {
      state.localTests = fixture.fixLocalTests || 'PASS';
      if (state.localTests !== 'PASS' && state.localTests !== 'SKIP') {
        applyStage(state, 'HUMAN_REVIEW_REQUIRED');
        break;
      }
    }
  }

  return { ok: state.stage === 'READY_FOR_HUMAN_MERGE', state, decision };
}

async function upsertStatus(client, { owner, name, issueNumber, state, body, dryRun, plan }) {
  if (dryRun) {
    plan.steps.push({ message: 'Would upsert status comment', write: true, skipped: true, body });
    return state;
  }
  if (state.statusCommentId) {
    await client.updateComment(owner, name, state.statusCommentId, body);
    return state;
  }
  const rec = await client.createComment(owner, name, issueNumber, body);
  return { ...state, statusCommentId: rec.id };
}

async function applyLabels(client, { owner, name, issueNumber, issue, stage, dryRun, plan, keepTrigger = true }) {
  const desired = reconcileStatusLabels(issue.labels || [], statusLabelForStage(stage), { keepTrigger });
  const diff = labelDiff(issue.labels || [], desired);
  if (dryRun) {
    plan.steps.push({ message: 'Would update labels', add: diff.add, remove: diff.remove, write: true, skipped: true });
    return;
  }
  for (const label of diff.remove) await client.removeLabel(owner, name, issueNumber, label);
  for (const label of diff.add) await client.addLabel(owner, name, issueNumber, label);
}

export async function inspectIssueAutomation({
  client,
  config,
  repo,
  issueNumber,
  env = process.env,
} = {}) {
  const { owner, name, slug } = parseRepoSlug(repo);
  const issue = await client.getIssue(owner, name, issueNumber);
  const events = await client.getIssueEvents(owner, name, issueNumber);
  const labeled = extractLabelEventActor(events, config.automation.trigger_label || TRIGGER_LABEL);
  let permission = labeled.permission;
  if (labeled.login && !permission) {
    try {
      const perm = await client.getCollaboratorPermission(owner, name, labeled.login);
      permission = perm.permission || perm.role_name || '';
    } catch {
      permission = '';
    }
  }
  const names = (issue.labels || []).map(l => l.name || l);
  const authorization = authorizeAiAutoTrigger({
    triggerLabelPresent: names.includes(config.automation.trigger_label || TRIGGER_LABEL),
    triggerLabelName: config.automation.trigger_label || TRIGGER_LABEL,
    actorLogin: labeled.login,
    association: labeled.association,
    permission,
    allowedUsers: config.automation.allowed_actors,
  });
  let routing = null;
  let routingError = '';
  try {
    routing = resolveIssueRouting(names);
  } catch (e) {
    routingError = e instanceof Error ? e.message : String(e);
  }
  const existingState = await loadIssueState(slug, issueNumber, env);
  const decision = decideTrigger({ config, labels: names, authorization, existingState });
  return {
    issue,
    routing,
    routingError,
    authorization,
    decision,
    state: existingState,
    statusText: formatGithubStatus({
      issue,
      automationMode: config.automation.mode,
      state: existingState || emptyState({ repo: slug, issue }),
    }),
  };
}

export async function runIssueAutomation({
  client,
  config,
  repo,
  issueNumber,
  dryRun = false,
  env = process.env,
  localRepo = '',
  runImplementation,
  waitForCi,
  gitPush,
  defaultBranch = 'main',
  ciTimeoutMs = 60 * 60 * 1000,
  eventLog,
} = {}) {
  const plan = { steps: [], writes: [] };
  const { owner, name, slug } = parseRepoSlug(repo);
  const events = eventLog || createGithubEventLog({
    persistPath: dryRun ? '' : issueEventsPath(slug, issueNumber, env),
  });
  const inspected = await inspectIssueAutomation({ client, config, repo: slug, issueNumber, env });
  const { issue, authorization, decision, routingError } = inspected;
  let routing = inspected.routing;
  const emit = (action, result, stage) => events.emit({
    repository: slug,
    issue: issueNumber,
    stage: stage || inspected.state?.stage || 'IDLE',
    action,
    result,
  });
  const done = (result) => ({ ...result, events: events.records });

  await emit('issue_received', decision.action, inspected.state?.stage || 'IDLE');
  if (decision.action !== 'block') {
    await emit(
      'authorization_checked',
      authorization?.ok ? 'allowed' : (decision.action || 'skip'),
      inspected.state?.stage || 'IDLE',
    );
  }

  if (decision.action === 'skip') {
    return done({ code: 0, skipped: true, decision, plan, state: inspected.state });
  }
  if (decision.action === 'cancel') {
    return done({ code: 0, cancelled: true, decision, plan, state: inspected.state });
  }
  if (decision.action === 'busy') {
    return done({ code: 2, skipped: true, decision, plan, state: inspected.state });
  }
  if (decision.action === 'already-complete' || decision.action === 'already-stopped') {
    return done({ code: 0, skipped: true, resumed: false, decision, plan, state: inspected.state });
  }
  if (decision.action === 'block') {
    let state = inspected.state || emptyState({ repo: slug, issue });
    applyStage(state, 'BLOCKED');
    state.lastFailure = BLOCK_UNTRUSTED;
    if (!dryRun) state = await saveIssueState(state, env);
    await emit('authorization_checked', 'blocked', 'BLOCKED');
    const body = formatStatusComment({
      headline: MILESTONE_HEADLINES.BLOCKED,
      diagnosis: `AUTOMATION BLOCKED\nReason: ${BLOCK_UNTRUSTED}`,
    });
    await upsertStatus(client, { owner, name, issueNumber, state, body, dryRun, plan });
    await applyLabels(client, { owner, name, issueNumber, issue, stage: 'BLOCKED', dryRun, plan, keepTrigger: true });
    return done({ code: 2, blocked: true, decision, plan, state });
  }

  if (routingError) {
    let state = inspected.state || emptyState({ repo: slug, issue });
    applyStage(state, 'CONFLICT');
    state.lastFailure = routingError;
    if (!dryRun) state = await saveIssueState(state, env);
    const body = formatStatusComment({
      headline: MILESTONE_HEADLINES.HUMAN_REVIEW_REQUIRED,
      diagnosis: routingError,
    });
    await upsertStatus(client, { owner, name, issueNumber, state, body, dryRun, plan });
    await applyLabels(client, { owner, name, issueNumber, issue, stage: 'CONFLICT', dryRun, plan });
    return done({ code: 2, conflict: true, decision, plan, state });
  }

  const lock = dryRun ? { ok: true } : await acquireIssueLock(slug, issueNumber, env);
  if (!lock.ok) {
    return done({ code: 2, skipped: true, decision: { action: 'busy', reason: lock.reason }, plan, state: inspected.state });
  }

  try {
    let state = inspected.state || emptyState({ repo: slug, issue });
    let skipGitPush = false;

    const existingPrs = await client.listPullsForIssue(owner, name, issueNumber);
    if (existingPrs.length && !state.prNumber) {
      state.prNumber = existingPrs[0].number;
      state.branch = existingPrs[0].head?.ref || existingPrs[0].head || state.branch;
      if (!dryRun) state = await saveIssueState(state, env);
    }

    if (decision.action === 'resume' && state.unsafePushPending) {
      const rec = await reconcileUnsafePushPending({ client, owner, name, state });
      if (rec.action !== 'reconciled') {
        applyStage(state, 'HUMAN_REVIEW_REQUIRED');
        state.lastDiagnosis = rec.reason;
        if (!dryRun) state = await saveIssueState(state, env);
        await applyLabels(client, { owner, name, issueNumber, issue, stage: 'HUMAN_REVIEW_REQUIRED', dryRun, plan });
        return done({ code: 2, needsConfirmation: true, plan, state, decision });
      }
      state.unsafePushPending = false;
      state.lastFailure = '';
      state.lastDiagnosis = '';
      skipGitPush = true;
      if (!dryRun) state = await saveIssueState(state, env);
    }

    const resumeWaitingForCi = decision.action === 'resume'
      && state.stage === 'WAITING_FOR_CI'
      && Boolean(state.prNumber);

    const resumeLocalTests = skipGitPush || resumeWaitingForCi || (
      decision.action === 'resume'
      && state.stage === 'LOCAL_TESTS'
      && (config.tests.required ? state.localTests === 'PASS' : ['PASS', 'SKIP'].includes(state.localTests))
      && (config.review.required ? state.review === 'PASS' : ['PASS', 'SKIP'].includes(state.review))
      && !state.prNumber
      && Boolean(state.branch && state.commitSha)
    );

    // Resume from IMPLEMENTING/FIXING/LOCAL_TESTS must not rewind to STARTED
    // (IMPLEMENTING → STARTED is illegal).
    const skipStartedHop = decision.action === 'resume'
      && !['IDLE', 'STARTED'].includes(state.stage || 'IDLE');
    const skipImplementation = Boolean(state.prNumber) || resumeLocalTests;

    if (decision.action !== 'resume' || !state.mode) state.mode = config.automation.mode;
    state.maxAttempts = config.automation.max_fix_attempts || state.maxAttempts;
    state.route = routing.worker;
    state.model = routing.selection === 'MANUAL' ? routing.model : 'AUTO';
    state.selectedRoute = routing.worker;
    state.selectedModels = state.model;
    if (!skipStartedHop) applyStage(state, 'STARTED');

    const taskCtx = buildIssueTaskContext({ issue, repository: slug, routing });

    if (dryRun) {
      dryLog(plan, 'Would start AI implementation', { route: routing.worker, model: routing.model });
      dryLog(plan, 'Would create isolated worktree and AI branch');
      if (config.pull_request.create) dryLog(plan, 'Would create pull request after local tests PASS');
      dryLog(plan, 'Would monitor GitHub CI and run bounded fix loop');
      dryLog(plan, 'Would never merge or publish');
      return done({ code: 0, dryRun: true, plan, state, decision, task: taskCtx.task });
    }

    if (!skipStartedHop && !skipImplementation) {
      await applyLabels(client, { owner, name, issueNumber, issue, stage: 'WORKING', dryRun, plan });
      applyStage(state, 'WORKING');
      state = await upsertStatus(client, {
        owner,
        name,
        issueNumber,
        state,
        dryRun,
        plan,
        body: formatStatusComment({
          headline: MILESTONE_HEADLINES.STARTED,
          route: state.route,
          model: state.model,
          attempt: Math.max(1, state.ciAttempts || 1),
          maxAttempts: state.maxAttempts,
        }),
      });
      state = await saveIssueState(state, env);
    }

    const branches = (await client.listBranches(owner, name)).map(b => b.name);
    if (!state.branch) state.branch = proposeBranchName(issue, { existingBranches: branches });

    async function implementRound({ fixContext } = {}) {
      const namesNow = (await client.getLabels(owner, name, issueNumber)).map(l => l.name || l);
      if (namesNow.includes(STOP_LABEL)) {
        applyStage(state, 'CANCELLED');
        return { stopped: true };
      }
      state.implementationAttempt = (state.implementationAttempt || 0) + 1;
      applyStage(state, fixContext ? 'FIXING' : 'IMPLEMENTING');
      state = await saveIssueState(state, env);
      await emit('implementation_started', fixContext ? 'fix' : 'start', state.stage);
      if (typeof runImplementation !== 'function') {
        throw new Error('Implementation adapter is required.');
      }
      const result = await runImplementation({
        repo: localRepo || process.cwd(),
        branch: state.branch,
        task: fixContext ? `${taskCtx.task}\n\n${fixContext}` : taskCtx.task,
        routing,
        state,
        env,
      });
      applyImplementationResult(state, result, config);
      const failed = result?.ok !== true || (config.tests.required && result.tests !== 'PASS') || (config.review.required && result.review !== 'PASS');
      if (!failed) applyStage(state, 'LOCAL_TESTS');
      state = await saveIssueState(state, env);
      await emit('implementation_completed', failed ? 'FAIL' : 'PASS', state.stage);
      await emit('local_tests_completed', state.localTests || (failed ? 'FAIL' : 'PASS'), state.stage);
      return { failed, result };
    }

    async function findExistingPullRequest() {
      const forIssue = await client.listPullsForIssue(owner, name, issueNumber);
      if (forIssue.length) return forIssue[0];
      if (typeof client.listPulls === 'function' && state.branch) {
        const listed = await client.listPulls(owner, name, { head: `${owner}:${state.branch}`, state: 'open' });
        if (listed?.length) return listed[0];
      }
      return null;
    }

    async function pushBranchAndOpenPr({ skipGitPush: skipPush = false } = {}) {
      assertSafePushBranch(state.branch);
      const existing = await findExistingPullRequest();
      if (existing?.number) {
        state.prNumber = existing.number;
        state.unsafePushPending = false;
        state.branchPushed = true;
        state = await saveIssueState(state, env);
        return { crashed: false };
      }
      const remoteSkip = skipPush
        ? { skip: true, reason: 'caller' }
        : await shouldSkipGitPush({ client, owner, name, state });
      if (remoteSkip.skip && remoteSkip.reason !== 'caller') {
        state.branchPushed = true;
        state.unsafePushPending = false;
      }
      if (!remoteSkip.skip && typeof gitPush === 'function') {
        state.unsafePushPending = true;
        state = await saveIssueState(state, env);
        await emit('push_started', state.branch, state.stage);
        try {
          const pushed = await gitPush({ branch: state.branch, repo: localRepo, repository: state.repository, expectedSha: state.commitSha, force: false });
          rememberPushedSha(state, pushed);
          state.unsafePushPending = false;
          state.branchPushed = true;
          state = await saveIssueState(state, env);
          await emit('push_completed', 'ok', state.stage);
        } catch (e) {
          state.lastFailure = e instanceof Error ? e.message : String(e);
          state = await saveIssueState(state, env);
          await emit('push_completed', 'FAIL', state.stage);
          return { crashed: true };
        }
      }
      if (config.pull_request.create && !state.prNumber) {
        try {
          const pr = await client.createPullRequest(owner, name, {
            title: prTitleForIssue(issue),
            body: prBodyForIssue({
              issue,
              repository: slug,
              route: state.route,
              models: state.model,
              localTests: state.localTests,
              githubCi: 'PENDING',
              attempt: 1,
              maxAttempts: state.maxAttempts,
              branch: state.branch,
              review: state.review,
            }),
            head: state.branch,
            base: defaultBranch,
          });
          state.prNumber = pr.number;
          state = await saveIssueState(state, env);
          await emit('pr_created', String(pr.number), state.stage);
        } catch (e) {
          state.lastFailure = e instanceof Error ? e.message : String(e);
          state = await saveIssueState(state, env);
          return { crashed: true };
        }
      }
      return { crashed: false };
    }

    const resumeMissingRequiredGate = decision.action === 'resume'
      && state.stage === 'LOCAL_TESTS'
      && ((!config.tests.required || state.localTests === 'PASS') === false || (!config.review.required || state.review === 'PASS') === false);
    if (resumeMissingRequiredGate) {
      applyStage(state, 'HUMAN_REVIEW_REQUIRED');
      state.lastDiagnosis = 'Required local tests or AI review did not pass';
      state = await saveIssueState(state, env);
      await emit('human_review_required', state.lastDiagnosis, state.stage);
      await applyLabels(client, { owner, name, issueNumber, issue, stage: state.stage, dryRun, plan });
      return done({ code: 1, plan, state, decision });
    }

    if (!skipImplementation) {
      const first = await implementRound();
      if (first.stopped) {
        state = await saveIssueState(state, env);
        await applyLabels(client, { owner, name, issueNumber, issue, stage: 'CANCELLED', dryRun, plan });
        return done({ code: 0, cancelled: true, plan, state, decision });
      }
      if (first.failed) {
        applyStage(state, 'FAILED');
        state.lastFailure = 'local tests failed';
        state = await saveIssueState(state, env);
        await applyLabels(client, { owner, name, issueNumber, issue, stage: 'FAILED', dryRun, plan });
        return done({ code: 1, plan, state });
      }
    }

    const requiredTestsOk = !config.tests.required || state.localTests === 'PASS';
    const requiredReviewOk = !config.review.required || state.review === 'PASS';
    if (!requiredTestsOk || !requiredReviewOk) {
      applyStage(state, 'HUMAN_REVIEW_REQUIRED');
      state.lastDiagnosis = 'Required local tests or AI review did not pass';
      state = await saveIssueState(state, env);
      await emit('human_review_required', state.lastDiagnosis, state.stage);
      await applyLabels(client, { owner, name, issueNumber, issue, stage: state.stage, dryRun, plan });
      return done({ code: 1, plan, state, decision });
    }

    if (!state.prNumber && (state.localTests === 'PASS' || (!config.tests.required && state.localTests === 'SKIP'))) {
      const pushed = await pushBranchAndOpenPr({ skipGitPush });
      if (pushed.crashed) {
        return done({ code: 1, crashed: true, plan, state });
      }
    }
    if (resumeWaitingForCi) {
      await emit('ci_started', state.commitSha || state.branch, state.stage);
      const sync = await readGithubCiStatus({ client, owner, name, state, config });
      if (sync.githubCi === 'FAIL') {
        state = recordCiResult(state, CI_STATUS.FAIL);
        state.lastFailure = sync.summary || 'GitHub CI failed';
      } else {
        state.githubCi = sync.githubCi;
        applyStage(state, sync.stage);
      }
      if (sync.githubCi === 'PASS') {
        state.lastFailure = '';
        state.pullRequestAutoMerged = false;
        state.published = false;
      }
      await emit('ci_completed', sync.githubCi, state.stage);
      if (state.stage === 'HUMAN_REVIEW_REQUIRED') {
        await emit('human_review_required', state.lastFailure || 'review', state.stage);
      }
      state = await saveIssueState(state, env);
      await applyLabels(client, { owner, name, issueNumber, issue, stage: state.stage, dryRun, plan });
      if (state.stage === 'READY_FOR_HUMAN_MERGE') {
        state = await upsertStatus(client, {
          owner, name, issueNumber, state, dryRun, plan,
          body: formatStatusComment({
            headline: MILESTONE_HEADLINES.READY_FOR_HUMAN_MERGE,
            localTests: state.localTests,
            githubCi: 'PASS',
            review: state.review || 'PASS',
            attempt: state.attempt,
            maxAttempts: state.maxAttempts,
          }),
        });
        state = await saveIssueState(state, env);
      }
      if (state.stage !== 'FIXING') {
        return done({
          code: state.stage === 'READY_FOR_HUMAN_MERGE' ? 0 : 1,
          plan,
          state,
          decision,
          waiting: state.stage === 'WAITING_FOR_CI',
        });
      }
    }

    if (state.stage !== 'FIXING') applyStage(state, 'WAITING_FOR_CI');
    await applyLabels(client, { owner, name, issueNumber, issue, stage: state.stage, dryRun, plan });
    state = await saveIssueState(state, env);

    const poll = typeof waitForCi === 'function'
      ? waitForCi
      : async ({ ref }) => {
        const runs = await fetchGithubCiRuns(client, owner, name, ref);
        return classifyCheckRuns(runs, { timeoutMs: ciTimeoutMs, startedAt: state.updatedAt });
      };

    while (state.stage === 'WAITING_FOR_CI' || state.stage === 'FIXING') {
      const namesNow = (await client.getLabels(owner, name, issueNumber)).map(l => l.name || l);
      if (namesNow.includes(STOP_LABEL)) {
        applyStage(state, 'CANCELLED');
        break;
      }
      if (state.stage === 'FIXING') {
        const logs = state.lastCiRun;
        const fixContext = collectCiFailureContext({
          issueTask: taskCtx.task,
          branch: state.branch,
          localTests: state.localTests,
          ci: { status: state.githubCi, summary: state.lastFailure },
          logs,
          previousAttempts: `${state.ciAttempts}/${state.maxAttempts}`,
          previousReview: state.review,
        });
        await applyLabels(client, { owner, name, issueNumber, issue, stage: 'FIXING', dryRun, plan });
        state = await upsertStatus(client, {
          owner, name, issueNumber, state, dryRun, plan,
          body: formatStatusComment({
            headline: MILESTONE_HEADLINES.CI_FAILED,
            attempt: state.ciAttempts + 1,
            maxAttempts: state.maxAttempts,
            failedChecks: state.lastFailure,
            nextAction: 'AI fix requested',
          }),
        });
        const fix = await implementRound({ fixContext });
        if (fix.stopped) {
          applyStage(state, 'CANCELLED');
          break;
        }
        if (fix.failed) {
          applyStage(state, 'HUMAN_REVIEW_REQUIRED');
          state.lastDiagnosis = 'Local tests failed during CI fix round';
          await emit('human_review_required', state.lastDiagnosis, state.stage);
          break;
        }
        assertSafePushBranch(state.branch);
        const fixSkip = await shouldSkipGitPush({ client, owner, name, state, ignoreExistingPr: true });
        if (fixSkip.skip) {
          state.branchPushed = true;
          state.unsafePushPending = false;
        } else if (typeof gitPush === 'function') {
          state.unsafePushPending = true;
          state = await saveIssueState(state, env);
          await emit('push_started', state.branch, state.stage);
          try {
            const pushed = await gitPush({ branch: state.branch, repo: localRepo, repository: state.repository, expectedSha: state.commitSha, force: false });
            rememberPushedSha(state, pushed);
            state.unsafePushPending = false;
            state.branchPushed = true;
            await emit('push_completed', 'ok', state.stage);
          } catch (e) {
            state.lastFailure = e instanceof Error ? e.message : String(e);
            state = await saveIssueState(state, env);
            await emit('push_completed', 'FAIL', state.stage);
            return done({ code: 1, crashed: true, plan, state });
          }
        }
        state = await upsertStatus(client, {
          owner, name, issueNumber, state, dryRun, plan,
          body: formatStatusComment({
            headline: MILESTONE_HEADLINES.FIX_PUSHED,
            commit: state.commitSha,
            attempt: state.ciAttempts,
            maxAttempts: state.maxAttempts,
          }),
        });
        applyStage(state, 'WAITING_FOR_CI');
        await applyLabels(client, { owner, name, issueNumber, issue, stage: 'WAITING_FOR_CI', dryRun, plan });
        state = await saveIssueState(state, env);
      }

      await emit('ci_started', state.commitSha || state.branch, state.stage);
      const ci = await poll({ ref: state.commitSha || state.branch, state });
      const status = typeof ci === 'string' ? ci : ci.status;
      if (status === CI_STATUS.PENDING) {
        state.githubCi = CI_STATUS.PENDING;
        applyStage(state, 'WAITING_FOR_CI');
        state = await saveIssueState(state, env);
        await emit('ci_completed', 'PENDING', state.stage);
        return done({ code: 0, waiting: true, plan, state, decision });
      }
      state = recordCiResult(state, status);
      await emit('ci_completed', status, state.stage);
      if (ci && typeof ci === 'object') {
        state.lastFailure = redactCiText(ci.summary || status);
        if (ci.logs) {
          try {
            const dirs = runtimeDirs(env);
            const logDir = path.join(dirs.root, 'github-automation', owner, name);
            await mkdir(logDir, { recursive: true });
            await writeFile(path.join(logDir, `issue-${issueNumber}-ci.log`), redactCiText(ci.logs), 'utf8');
          } catch {
            /* non-fatal */
          }
        }
      }
      if (state.stage === 'READY_FOR_HUMAN_MERGE') {
        const reviewOk = !config.review.required || state.review === 'PASS';
        const testsOk = !config.tests.required || state.localTests === 'PASS';
        if (!reviewOk || !testsOk) {
          applyStage(state, 'HUMAN_REVIEW_REQUIRED');
          state.lastDiagnosis = 'GitHub CI passed but required local tests or AI review did not pass';
          await emit('human_review_required', state.lastDiagnosis, state.stage);
          break;
        }
        state = await upsertStatus(client, {
          owner, name, issueNumber, state, dryRun, plan,
          body: formatStatusComment({
            headline: MILESTONE_HEADLINES.READY_FOR_HUMAN_MERGE,
            localTests: state.localTests,
            githubCi: 'PASS',
            review: state.review || 'PASS',
            attempt: state.attempt,
            maxAttempts: state.maxAttempts,
          }),
        });
        break;
      }
      if (state.stage === 'HUMAN_REVIEW_REQUIRED') {
        await emit('human_review_required', state.lastFailure || 'review', state.stage);
        state = await upsertStatus(client, {
          owner, name, issueNumber, state, dryRun, plan,
          body: formatStatusComment({
            headline: MILESTONE_HEADLINES.HUMAN_REVIEW_REQUIRED,
            attempt: state.attempt,
            maxAttempts: state.maxAttempts,
            failedChecks: state.lastFailure,
            diagnosis: state.lastDiagnosis || 'Maximum GitHub fix attempts reached',
            branch: state.branch,
            pr: state.prNumber ? `#${state.prNumber}` : '',
          }),
        });
        break;
      }
    }

    if (state.stage === 'READY_FOR_HUMAN_MERGE') {
      await applyLabels(client, { owner, name, issueNumber, issue, stage: 'READY_FOR_HUMAN_MERGE', dryRun, plan });
    } else if (state.stage === 'CANCELLED') {
      await applyLabels(client, { owner, name, issueNumber, issue, stage: 'CANCELLED', dryRun, plan });
    } else if (state.stage === 'HUMAN_REVIEW_REQUIRED') {
      await applyLabels(client, { owner, name, issueNumber, issue, stage: 'HUMAN_REVIEW_REQUIRED', dryRun, plan });
    }
    state.pullRequestAutoMerged = false;
    state.published = false;
    state = await saveIssueState(state, env);
    return done({ code: state.stage === 'READY_FOR_HUMAN_MERGE' ? 0 : 1, plan, state, decision });
  } finally {
    if (!dryRun) await releaseIssueLock(slug, issueNumber, env);
  }
}

export async function resumeIssueAutomation(options) {
  return runIssueAutomation(options);
}

export function implementationArgv({ repo, branch, taskFile, routing, commitOnPass = true }) {
  const argv = ['--repo', repo, '--mode', routing.mode || 'auto', '--branch', branch, '--task-file', taskFile];
  if (commitOnPass) argv.push('--commit-on-pass');
  if (routing.selection === 'MANUAL' && routing.model && routing.worker !== 'TEAM') {
    if (routing.worker === 'CODEX') argv.push('--codex-model', routing.model);
    else if (routing.worker === 'GEMINI') argv.push('--gemini-model', routing.model);
    else if (routing.worker === 'CURSOR') argv.push('--cursor-model', routing.model);
    else argv.push('--model', routing.model);
  }
  return argv;
}
