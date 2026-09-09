import { slugifyTask } from './workspace.mjs';

export const PROTECTED_BRANCHES = new Set(['main', 'master']);

export function proposeBranchName(issue, { existingBranches = [] } = {}) {
  const number = Number(issue?.number || 0);
  const slug = slugifyTask(issue?.title || 'task').slice(0, 40);
  const base = `ai/issue-${number}-${slug}`;
  const existing = new Set((existingBranches || []).map(String));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 30; i++) {
    const name = `${base}-${i}`;
    if (!existing.has(name)) return name;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function assertSafePushBranch(branch) {
  const name = String(branch || '').trim();
  if (!name) throw new Error('Missing branch name.');
  if (PROTECTED_BRANCHES.has(name.toLowerCase())) {
    throw new Error(`Refusing to push protected branch: ${name}`);
  }
  if (!/^ai\//.test(name)) {
    throw new Error(`Refusing to push a non-ai branch from GitHub automation: ${name}`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) {
    throw new Error(`Unsafe branch name: ${name}`);
  }
  return name;
}

export function prTitleForIssue(issue) {
  const number = Number(issue?.number || 0);
  const title = String(issue?.title || 'AI task').replace(/\s+/g, ' ').trim();
  return `Fix #${number}: ${title}`.slice(0, 120);
}

export function prBodyForIssue({
  issue,
  repository,
  route,
  models,
  localTests,
  githubCi = 'NOT RUN',
  attempt,
  maxAttempts,
  branch,
  review = 'PENDING',
} = {}) {
  const number = Number(issue?.number || 0);
  const url = issue?.html_url || '';
  const modelLine = typeof models === 'string' ? models : formatModels(models);
  return [
    `Closes #${number}`,
    '',
    '## AI Automation Summary',
    '',
    `Route: ${route || 'AUTO'}`,
    '',
    `Models: ${modelLine}`,
    '',
    `Local Tests: ${localTests || 'UNKNOWN'}`,
    '',
    `GitHub CI: ${githubCi}`,
    '',
    `AI Review: ${review}`,
    '',
    `Attempt: ${attempt}/${maxAttempts}`,
    '',
    `Branch: \`${branch}\``,
    '',
    'Original Issue:',
    url || `#${number}`,
    '',
    '## Safety',
    '',
    '- Main workspace unchanged',
    '- Isolated Git worktree used for implementation',
    '- v1.1 does **not** auto-merge, deploy, or publish',
    '- GitHub CI is reported only after actual check results',
    '',
    repository ? `Repository: ${repository}` : '',
  ].filter(line => line !== '').join('\n');
}

function formatModels(models) {
  if (!models) return 'AUTO';
  if (models.worker?.model) return String(models.worker.model);
  if (models.stages) {
    const s = models.stages;
    return [
      s.plan?.model && `plan=${s.plan.model}`,
      s.implementation?.model && `implement=${s.implementation.model}`,
      s.review?.model && `review=${s.review.model}`,
    ].filter(Boolean).join(', ') || 'AUTO';
  }
  return JSON.stringify(models);
}

export function formatStatusComment({
  headline,
  route,
  model,
  attempt,
  maxAttempts,
  failedChecks,
  nextAction,
  commit,
  localTests,
  githubCi,
  review,
  branch,
  pr,
  diagnosis,
} = {}) {
  const lines = [`AI Automation — ${headline}`];
  if (route) lines.push('', `Route: ${route}`);
  if (model) lines.push('', `Model: ${model}`);
  if (attempt != null && maxAttempts != null) lines.push('', `Attempt: ${attempt}/${maxAttempts}`);
  if (failedChecks) lines.push('', 'Failed checks:', failedChecks);
  if (nextAction) lines.push('', `Next action: ${nextAction}`);
  if (commit) lines.push('', `Commit: ${commit}`, '', 'Waiting for CI');
  if (localTests) lines.push('', `Local Tests: ${localTests}`);
  if (githubCi) lines.push('', `GitHub CI: ${githubCi}`);
  if (review) lines.push('', `AI Review: ${review}`);
  if (diagnosis) lines.push('', 'Last AI diagnosis:', diagnosis);
  if (branch) lines.push('', `Branch: ${branch}`);
  if (pr) lines.push('', `PR: ${pr}`);
  return lines.join('\n');
}

export function formatGithubStatus({
  issue,
  automationMode,
  state,
} = {}) {
  const number = issue?.number || state?.issueNumber;
  const title = issue?.title || state?.issueTitle || '';
  return [
    'Issue:',
    `#${number} ${title}`.trim(),
    '',
    'Automation:',
    String(automationMode || state?.mode || 'MANUAL').toUpperCase(),
    '',
    'State:',
    state?.stage || 'IDLE',
    '',
    'Attempt:',
    `${state?.ciAttempts || state?.attempt || 0} / ${state?.maxAttempts || 5}`,
    '',
    'Route:',
    state?.route || 'AUTO',
    '',
    'Model:',
    state?.model || 'AUTO',
    '',
    'Branch:',
    state?.branch || '(none)',
    '',
    'PR:',
    state?.prNumber ? `#${state.prNumber}` : '(none)',
    '',
    'Local Tests:',
    state?.localTests || 'UNKNOWN',
    '',
    'GitHub CI:',
    state?.githubCi || 'UNKNOWN',
  ].join('\n');
}

export const MILESTONE_HEADLINES = Object.freeze({
  STARTED: 'Started',
  CI_FAILED: 'CI Failed',
  FIX_PUSHED: 'Fix Pushed',
  READY_FOR_HUMAN_MERGE: 'Ready for Human Merge',
  HUMAN_REVIEW_REQUIRED: 'HUMAN REVIEW REQUIRED',
  BLOCKED: 'Blocked',
  CANCELLED: 'Cancelled',
});
