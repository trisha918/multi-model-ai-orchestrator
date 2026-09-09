import { redactCiText } from './github-ci.mjs';
import { LABEL_DEFINITIONS } from './github-labels.mjs';

const API = 'https://api.github.com';

export function redactGithubText(text) {
  return redactCiText(text)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/ghu_[A-Za-z0-9_]+/g, 'ghu_[redacted]');
}

function headerToken(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || '';
  return String(token).trim();
}

export function detectGithubAuth(env = process.env, { ghResolved = '' } = {}) {
  const tokenPresent = Boolean(headerToken(env));
  if (ghResolved) {
    return {
      method: tokenPresent ? 'gh+env' : 'gh',
      ok: true,
      gh: ghResolved,
      tokenPresent,
      detail: tokenPresent ? 'GitHub CLI plus environment token (token not logged)' : 'GitHub CLI',
    };
  }
  if (tokenPresent) {
    return {
      method: 'env',
      ok: true,
      gh: '',
      tokenPresent: true,
      detail: 'GITHUB_TOKEN or GH_TOKEN present (value not logged)',
    };
  }
  return {
    method: 'none',
    ok: false,
    gh: '',
    tokenPresent: false,
    detail: 'ACTION REQUIRED: install/auth GitHub CLI (`gh auth login`) or set GITHUB_TOKEN / GH_TOKEN',
  };
}

export function createGithubClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  exec,
  ghPath = '',
  now = () => new Date().toISOString(),
} = {}) {
  void now;
  const token = headerToken(env);
  const auth = detectGithubAuth(env, { ghResolved: ghPath });

  async function request(method, apiPath, body) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('GitHub HTTP client is unavailable.');
    }
    if (!token && !exec) {
      throw new Error('GitHub authentication is not configured.');
    }
    if (exec && ghPath && !token) {
      const args = ['api', '-X', method, apiPath];
      if (body !== undefined) args.push('--input', '-');
      const result = await exec(ghPath, args, { input: body === undefined ? null : JSON.stringify(body) });
      const text = `${result.stdout || ''}`;
      if (result.exitCode !== 0) {
        throw new Error(redactGithubText(result.stderr || result.stdout || `gh api failed (${result.exitCode})`));
      }
      return text.trim() ? JSON.parse(text) : {};
    }
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'multi-model-ai-orchestrator',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchImpl(`${API}${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(redactGithubText(`GitHub API ${res.status} ${apiPath}: ${raw.slice(0, 500)}`));
    }
    return raw.trim() ? JSON.parse(raw) : {};
  }

  return {
    auth,
    redact: redactGithubText,
    async getRepo(owner, name) {
      return request('GET', `/repos/${owner}/${name}`);
    },
    async getIssue(owner, name, number) {
      return request('GET', `/repos/${owner}/${name}/issues/${number}`);
    },
    async getLabels(owner, name, number) {
      const issue = await this.getIssue(owner, name, number);
      return issue.labels || [];
    },
    async addLabel(owner, name, number, label) {
      return request('POST', `/repos/${owner}/${name}/issues/${number}/labels`, { labels: [label] });
    },
    async removeLabel(owner, name, number, label) {
      const encoded = encodeURIComponent(label);
      return request('DELETE', `/repos/${owner}/${name}/issues/${number}/labels/${encoded}`);
    },
    async listRepoLabels(owner, name) {
      return request('GET', `/repos/${owner}/${name}/labels?per_page=100`);
    },
    async createLabel(owner, name, def) {
      return request('POST', `/repos/${owner}/${name}/labels`, {
        name: def.name,
        color: def.color,
        description: def.description,
      });
    },
    async ensureLabels(owner, name, defs = LABEL_DEFINITIONS) {
      const existing = await this.listRepoLabels(owner, name);
      const have = new Set((existing || []).map(l => l.name));
      const created = [];
      const skipped = [];
      for (const def of defs) {
        if (have.has(def.name)) skipped.push(def.name);
        else {
          await this.createLabel(owner, name, def);
          created.push(def.name);
        }
      }
      return { created, skipped };
    },
    async createComment(owner, name, number, body) {
      return request('POST', `/repos/${owner}/${name}/issues/${number}/comments`, { body });
    },
    async updateComment(owner, name, commentId, body) {
      return request('PATCH', `/repos/${owner}/${name}/issues/comments/${commentId}`, { body });
    },
    async listIssueComments(owner, name, number) {
      return request('GET', `/repos/${owner}/${name}/issues/${number}/comments?per_page=50`);
    },
    async getIssueEvents(owner, name, number) {
      return request('GET', `/repos/${owner}/${name}/issues/${number}/events?per_page=100`);
    },
    async getCollaboratorPermission(owner, name, username) {
      return request('GET', `/repos/${owner}/${name}/collaborators/${encodeURIComponent(username)}/permission`);
    },
    async listPullsForIssue(owner, name, issueNumber) {
      const q = encodeURIComponent(`repo:${owner}/${name} is:pr ${issueNumber}`);
      const data = await request('GET', `/search/issues?q=${q}`);
      return data.items || [];
    },
    async createPullRequest(owner, name, { title, body, head, base }) {
      return request('POST', `/repos/${owner}/${name}/pulls`, { title, body, head, base });
    },
    async getPullRequest(owner, name, number) {
      return request('GET', `/repos/${owner}/${name}/pulls/${number}`);
    },
    async getBranch(owner, name, branch) {
      try {
        return await request('GET', `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/\b404\b/.test(msg)) return null;
        throw e;
      }
    },
    async listPulls(owner, name, { head, state: prState = 'open' } = {}) {
      const params = new URLSearchParams({ state: prState, per_page: '30' });
      if (head) params.set('head', head.includes(':') ? head : `${owner}:${head}`);
      return request('GET', `/repos/${owner}/${name}/pulls?${params}`);
    },
    async getChecks(owner, name, ref) {
      return request('GET', `/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}/check-runs`);
    },
    async getCombinedStatus(owner, name, ref) {
      return request('GET', `/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}/status`);
    },
    async getWorkflowRun(owner, name, runId) {
      return request('GET', `/repos/${owner}/${name}/actions/runs/${runId}`);
    },
    async getLogs(owner, name, runId) {
      try {
        return await request('GET', `/repos/${owner}/${name}/actions/runs/${runId}/logs`);
      } catch (e) {
        return { unavailable: true, error: redactGithubText(e instanceof Error ? e.message : String(e)) };
      }
    },
    async listBranches(owner, name) {
      return request('GET', `/repos/${owner}/${name}/branches?per_page=100`);
    },
    async listRunners(owner, name) {
      return request('GET', `/repos/${owner}/${name}/actions/runners?per_page=100`);
    },
  };
}

export function createMemoryGithubClient(seed = {}) {
  const issues = new Map(Object.entries(seed.issues || {}));
  const comments = new Map();
  const labels = new Set((seed.repoLabels || []).map(l => l.name || l));
  const pulls = [...(seed.pulls || [])];
  const checksByRef = { ...(seed.checks || {}) };
  const events = { ...(seed.events || {}) };
  const permissions = { ...(seed.permissions || {}) };
  const log = [];
  let commentId = 1;
  let prId = 100;

  const client = {
    auth: { ok: true, method: 'mock', tokenPresent: false, detail: 'in-memory mock' },
    redact: redactGithubText,
    log,
    async getRepo() {
      return seed.repo || { private: true, default_branch: 'main' };
    },
    async getIssue(owner, name, number) {
      return issues.get(String(number)) || { number, title: '', body: '', labels: [], html_url: '', user: { login: 'someone' } };
    },
    async getLabels(owner, name, number) {
      const issue = await this.getIssue(owner, name, number);
      return issue.labels || [];
    },
    async addLabel(owner, name, number, label) {
      log.push({ op: 'addLabel', number, label });
      const issue = await this.getIssue(owner, name, number);
      issue.labels = [...(issue.labels || []), { name: label }];
      issues.set(String(number), issue);
      return issue.labels;
    },
    async removeLabel(owner, name, number, label) {
      log.push({ op: 'removeLabel', number, label });
      const issue = await this.getIssue(owner, name, number);
      issue.labels = (issue.labels || []).filter(l => (l.name || l) !== label);
      issues.set(String(number), issue);
      return issue.labels;
    },
    async listRepoLabels() {
      return [...labels].map(name => ({ name }));
    },
    async createLabel(owner, name, def) {
      log.push({ op: 'createLabel', name: def.name });
      labels.add(def.name);
      return def;
    },
    async ensureLabels(owner, name, defs = LABEL_DEFINITIONS) {
      const created = [];
      const skipped = [];
      for (const def of defs) {
        if (labels.has(def.name)) skipped.push(def.name);
        else {
          labels.add(def.name);
          created.push(def.name);
        }
      }
      return { created, skipped };
    },
    async createComment(owner, name, number, body) {
      log.push({ op: 'createComment', number, body });
      const rec = { id: commentId++, body, number };
      const list = comments.get(String(number)) || [];
      list.push(rec);
      comments.set(String(number), list);
      return rec;
    },
    async updateComment(owner, name, id, body) {
      log.push({ op: 'updateComment', id, body });
      for (const list of comments.values()) {
        const rec = list.find(c => c.id === id);
        if (rec) rec.body = body;
      }
      return { id, body };
    },
    async listIssueComments(owner, name, number) {
      return comments.get(String(number)) || [];
    },
    async getIssueEvents(owner, name, number) {
      return events[String(number)] || [];
    },
    async getCollaboratorPermission(owner, name, username) {
      return permissions[username] || { permission: 'none', user: { login: username } };
    },
    async listPullsForIssue(owner, name, issueNumber) {
      return pulls.filter(p => p.issueNumber === issueNumber || String(p.body || '').includes(`#${issueNumber}`));
    },
    async createPullRequest(owner, name, payload) {
      log.push({ op: 'createPullRequest', ...payload });
      const pr = { number: ++prId, ...payload, html_url: `https://github.com/${owner}/${name}/pull/${prId}` };
      pulls.push(pr);
      return pr;
    },
    async getPullRequest(owner, name, number) {
      return pulls.find(p => p.number === number) || null;
    },
    async getBranch(owner, name, branch) {
      log.push({ op: 'getBranch', branch });
      const map = seed.remoteBranches || {};
      if (!Object.prototype.hasOwnProperty.call(map, branch)) return null;
      return { name: branch, commit: { sha: map[branch] } };
    },
    async listPulls(owner, name, { head } = {}) {
      log.push({ op: 'listPulls', head });
      const want = String(head || '').includes(':') ? String(head).slice(String(head).indexOf(':') + 1) : String(head || '');
      if (!want) return [...pulls];
      return pulls.filter(p => {
        const ref = typeof p.head === 'string' ? p.head : p.head?.ref;
        return ref === want;
      });
    },
    async getChecks(owner, name, ref) {
      const runs = checksByRef[ref] || [];
      return { check_runs: runs };
    },
    async getCombinedStatus() {
      return { statuses: [], state: 'pending' };
    },
    async getWorkflowRun() {
      return { id: 1, status: 'completed', conclusion: 'success' };
    },
    async getLogs() {
      return { unavailable: false, text: 'log' };
    },
    async listBranches() {
      return (seed.branches || []).map(name => ({ name }));
    },
    async listRunners() {
      return { runners: seed.runners || [] };
    },
    setChecks(ref, runs) {
      checksByRef[ref] = runs;
    },
    setIssue(number, issue) {
      issues.set(String(number), issue);
    },
  };
  return client;
}
