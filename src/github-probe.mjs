/** Permissions the automate job must grant for Issue→PR→CI observation. */
export const AUTOMATE_REQUIRED_PERMISSIONS = Object.freeze({
  contents: 'write',
  issues: 'write',
  'pull-requests': 'write',
  checks: 'read',
  statuses: 'read',
  actions: 'read',
});

/** CI aggregation reads Check Runs, commit statuses, and Actions metadata. */
export const CI_OBSERVATION_READ_PERMISSIONS = Object.freeze({
  actions: 'read',
  checks: 'read',
  statuses: 'read',
});

export function summarizeRepoPermissions(repo = {}) {
  const p = repo.permissions || {};
  const write = Boolean(p.admin || p.maintain || p.push);
  return {
    private: Boolean(repo.private),
    defaultBranch: repo.default_branch || 'main',
    contents: write ? 'write' : (p.pull ? 'read' : 'unknown'),
    issues: write || p.triage ? (write ? 'write' : 'triage') : 'unknown',
    pullRequests: write ? 'write' : 'unknown',
    // Token scope for CI is workflow YAML, not the collaborator bit on the repo object.
    ciObservation: 'requires actions: read, checks: read, statuses: read (ai-issue.yml)',
    push: Boolean(p.push || p.admin || p.maintain),
  };
}

export function parseWorkflowPermissionBlock(blockText = '') {
  const map = {};
  for (const line of String(blockText || '').split('\n')) {
    const m = line.match(/^\s*([a-z0-9-]+):\s*(\w+)\s*$/i);
    if (m) map[m[1].toLowerCase()] = m[2].toLowerCase();
  }
  return map;
}

/**
 * Extract top-level and automate-job permission maps from ai-issue.yml.
 * Job-level `permissions` replace (do not merge with) top-level grants.
 */
export function extractAiIssueWorkflowPermissionBlocks(yamlText = '') {
  const text = String(yamlText || '').replace(/\r\n/g, '\n');
  const top = text.match(/^permissions:\n((?: {2}[^\n]+\n)*)/m);
  const automateSection = text.match(/\n {2}automate:\n([\s\S]*?)(?=\n {2}[a-zA-Z_]|\n[a-zA-Z]|$)/);
  const automatePerms = automateSection
    ? String(automateSection[1]).match(/\n {4}permissions:\n((?: {6}[^\n]+\n)*)/)
    : null;
  return {
    topLevel: parseWorkflowPermissionBlock(top?.[1]),
    automate: parseWorkflowPermissionBlock(automatePerms?.[1]),
  };
}

/**
 * Validate AI Issue workflow grants needed for CI observation and PR automation.
 * Prefers the automate job block when present (GHA job permissions replace top-level).
 */
export function summarizeAiIssueWorkflowPermissions(yamlText = '') {
  const { topLevel, automate } = extractAiIssueWorkflowPermissionBlocks(yamlText);
  const effective = Object.keys(automate).length ? automate : topLevel;
  const missing = [];
  const present = {};
  for (const [key, level] of Object.entries(AUTOMATE_REQUIRED_PERMISSIONS)) {
    const actual = effective[key] || 'missing';
    present[key] = actual;
    if (actual !== level) missing.push(`${key}: ${level}`);
  }
  const ciReads = Object.entries(CI_OBSERVATION_READ_PERMISSIONS).map(([key, level]) => {
    const actual = effective[key] || 'missing';
    return { key, required: level, actual, ok: actual === level };
  });
  const ciMissing = ciReads.filter(r => !r.ok).map(r => `${r.key}: ${r.required}`);
  return {
    ok: missing.length === 0,
    ciOk: ciMissing.length === 0,
    missing,
    ciMissing,
    present,
    ciReads,
    effective,
    detail: ciMissing.length
      ? `MISSING CI read permission(s): ${ciMissing.join(', ')} (CI needs actions, checks, and statuses)`
      : (missing.length
        ? `MISSING workflow permission(s): ${missing.join(', ')}`
        : 'OK actions: read, checks: read, statuses: read'),
  };
}

export function summarizeAiRunners(payload) {
  const runners = payload?.runners || payload || [];
  const list = Array.isArray(runners) ? runners : [];
  const wanted = new Set(['self-hosted', 'windows', 'ai-orchestrator']);
  const matches = list.filter((r) => {
    const labels = (r.labels || []).map(l => String(l.name || l).toLowerCase());
    return [...wanted].every(w => labels.includes(w));
  });
  const online = matches.filter(r => String(r.status || '').toLowerCase() === 'online');
  if (!list.length) {
    return { found: false, online: false, detail: 'NONE (API returned no runners or listing is unavailable)' };
  }
  if (!matches.length) {
    return { found: false, online: false, detail: `NONE matching [self-hosted, Windows, ai-orchestrator] (${list.length} runner(s) in repo)` };
  }
  if (!online.length) {
    return { found: true, online: false, detail: `OFFLINE (${matches.map(r => r.name).join(', ')})` };
  }
  return {
    found: true,
    online: true,
    detail: `ONLINE: ${online.map(r => r.name).join(', ')}`,
    names: online.map(r => r.name),
  };
}

export function formatGithubRepoDoctor({
  repoSlug,
  auth,
  repo,
  permissions,
  runners,
  workflowPermissions,
  error,
} = {}) {
  const lines = ['GitHub doctor'];
  lines.push('', `Auth: ${auth?.ok ? 'OK (token or gh present; value not logged)' : 'ACTION REQUIRED'}`);
  if (!repoSlug) {
    lines.push('', 'Pass --repo owner/name to probe repository access, PR/issue capability, and runners.');
    return lines.join('\n');
  }
  lines.push('', `Repository: ${repoSlug}`);
  if (error) {
    lines.push(`Access: FAIL (${error})`);
    lines.push('Do not print tokens. Re-authenticate with gh or GITHUB_TOKEN.');
    return lines.join('\n');
  }
  lines.push(`Visibility: ${permissions?.private ? 'private' : 'public'}`);
  lines.push(`Contents: ${permissions?.contents}`);
  lines.push(`Issues: ${permissions?.issues}`);
  lines.push(`Pull requests: ${permissions?.pullRequests}`);
  if (workflowPermissions) {
    lines.push(`CI observation (Check Runs + commit statuses): ${workflowPermissions.detail}`);
    for (const r of workflowPermissions.ciReads || []) {
      lines.push(`  ${r.key}: ${r.ok ? 'read' : `MISSING (have ${r.actual})`}`);
    }
  } else {
    lines.push(`CI observation: ${permissions?.ciObservation || 'requires actions: read, checks: read, statuses: read (ai-issue.yml)'}`);
  }
  lines.push(`Self-hosted AI runner: ${runners?.detail || 'UNKNOWN'}`);
  lines.push('', 'Tokens are never printed.');
  return lines.join('\n');
}

export async function probeGithubRepo(client, owner, name) {
  const repo = await client.getRepo(owner, name);
  const permissions = summarizeRepoPermissions(repo);
  let runners = { found: false, online: false, detail: 'UNKNOWN (runner list not permitted or failed)' };
  try {
    const payload = await client.listRunners(owner, name);
    runners = summarizeAiRunners(payload);
  } catch (e) {
    runners = {
      found: false,
      online: false,
      detail: `UNKNOWN (${e instanceof Error ? e.message : String(e)})`.slice(0, 240),
    };
  }
  return { repo, permissions, runners };
}
