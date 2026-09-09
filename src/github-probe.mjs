export function summarizeRepoPermissions(repo = {}) {
  const p = repo.permissions || {};
  const write = Boolean(p.admin || p.maintain || p.push);
  return {
    private: Boolean(repo.private),
    defaultBranch: repo.default_branch || 'main',
    contents: write ? 'write' : (p.pull ? 'read' : 'unknown'),
    issues: write || p.triage ? (write ? 'write' : 'triage') : 'unknown',
    pullRequests: write ? 'write' : 'unknown',
    checks: 'read (workflow grants actions: read / checks: read)',
    push: Boolean(p.push || p.admin || p.maintain),
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
  lines.push(`Actions/checks: ${permissions?.checks}`);
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
