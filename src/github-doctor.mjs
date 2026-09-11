import { findOnPath } from './tooling.mjs';
import { detectGithubAuth } from './github-client.mjs';
import { loadRepoAutomationConfig, isIssueAutomationActive } from './github-config.mjs';
import { LABEL_DEFINITIONS } from './github-labels.mjs';
import { installationInfo } from './paths.mjs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { emptyState, loadIssueState, parseRepoSlug, issueStatePath } from './github-state.mjs';
import { readGithubCiStatus } from './github-automation.mjs';
import { probeGithubRepo, summarizeAiRunners, summarizeAiIssueWorkflowPermissions } from './github-probe.mjs';

export async function collectGithubDoctor({ env = process.env, cwd = process.cwd(), checkAuth } = {}) {
  const ghPath = findOnPath(process.platform === 'win32' ? ['gh.exe', 'gh.cmd'] : ['gh']);
  let auth = detectGithubAuth(env, { ghResolved: ghPath });
  if (typeof checkAuth === 'function' && ghPath && !env.GITHUB_TOKEN && !env.GH_TOKEN) {
    try {
      const live = await checkAuth();
      if (live && live.ok === false) {
        auth = { ...auth, ok: false, detail: live.detail || auth.detail };
      } else if (live?.ok) {
        auth = { ...auth, ok: true, detail: live.detail || auth.detail };
      }
    } catch {
      /* GitHub is optional */
    }
  }

  const loaded = await loadRepoAutomationConfig(cwd);
  let configText = 'not present (automation stays disabled)';
  let configOk = true;
  if (!loaded.missing) {
    if (!loaded.ok) {
      configOk = false;
      configText = `INVALID — ${loaded.error} (automation remains disabled)`;
    } else {
      const mode = loaded.config.automation.mode;
      const enabled = isIssueAutomationActive(loaded.config);
      configText = enabled
        ? `OK mode=${mode} enabled=true trigger=${loaded.config.automation.trigger_label}`
        : `OK mode=${mode} issue-automation=off`;
    }
  }

  const labelsNote = `${LABEL_DEFINITIONS.length} documented labels (run: ai-orchestrator github labels setup --repo owner/name)`;
  const info = installationInfo(env);

  return {
    optional: true,
    auth,
    config: { ok: configOk, text: configText, path: loaded.path },
    labels: { text: labelsNote },
    runner: {
      text: 'Self-hosted Windows AI runner is documented; this doctor does not register a runner or fail if one is missing.',
    },
    stateDir: info.githubAutomation,
  };
}

export function formatGithubDoctor(github) {
  if (!github) return '';
  const authLine = github.auth.ok ? `OK (${github.auth.detail})` : `ACTION REQUIRED — ${github.auth.detail}`;
  return [
    'GitHub automation (optional):',
    `GitHub CLI/API: ${authLine}`,
    `Repository config: ${github.config.text}`,
    `Required labels: ${github.labels.text}`,
    `Self-hosted runner: ${github.runner.text}`,
    `Automation state: ${github.stateDir}`,
    '',
    'GitHub automation is optional and does not fail doctor by itself.',
  ].join('\n');
}

export async function collectIssueDoctor({
  client,
  repo,
  issueNumber,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const { owner, name, slug } = parseRepoSlug(repo);
  const n = Number(issueNumber);
  const problems = [];
  const auth = detectGithubAuth(env, {
    ghResolved: findOnPath(process.platform === 'win32' ? ['gh.exe', 'gh.cmd'] : ['gh']),
  });
  if (!auth.ok) problems.push(`Authentication: ${auth.detail}`);

  const loaded = await loadRepoAutomationConfig(cwd);
  let configText = 'not present (automation stays disabled)';
  if (loaded.missing) {
    problems.push('Workflow configuration: repository automation YAML is missing');
  } else if (!loaded.ok) {
    configText = `INVALID — ${loaded.error}`;
    problems.push(`Workflow configuration: ${loaded.error}`);
  } else {
    const mode = loaded.config.automation.mode;
    const enabled = isIssueAutomationActive(loaded.config);
    configText = enabled
      ? `OK mode=${mode} enabled=true`
      : `OK mode=${mode} issue-automation=off`;
  }

  const workflowCandidates = [
    path.join(cwd, '.github', 'workflows', 'ai-issue.yml'),
    path.join(cwd, '.github', 'ai-orchestrator.yml'),
  ];
  const workflowPath = workflowCandidates.find(p => existsSync(p));
  let workflowPermissions = null;
  if (!workflowPath) {
    problems.push('Workflow configuration: ai-issue.yml / ai-orchestrator.yml not found in cwd');
    if (!configText.startsWith('INVALID') && loaded.missing) {
      configText = 'MISSING workflow files in cwd';
    }
  } else if (loaded.ok || loaded.missing) {
    configText = `${configText}; workflow=${path.relative(cwd, workflowPath) || workflowPath}`;
  }

  const aiIssuePath = path.join(cwd, '.github', 'workflows', 'ai-issue.yml');
  if (existsSync(aiIssuePath)) {
    try {
      workflowPermissions = summarizeAiIssueWorkflowPermissions(readFileSync(aiIssuePath, 'utf8'));
      if (!workflowPermissions.ciOk) {
        problems.push(`Workflow CI permissions: ${workflowPermissions.detail}`);
      } else if (!workflowPermissions.ok) {
        problems.push(`Workflow permissions: ${workflowPermissions.detail}`);
      }
    } catch (e) {
      problems.push(`Workflow permissions: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (workflowPath && path.basename(workflowPath) !== 'ai-issue.yml') {
    problems.push('Workflow CI permissions: ai-issue.yml not found (needs actions/checks/statuses read)');
  }

  const stateFile = issueStatePath(slug, n, env);
  const state = await loadIssueState(slug, n, env);
  if (!state) problems.push(`Current state file: missing (${stateFile})`);
  const effective = state || emptyState({ repo: slug, issue: { number: n } });
  const stage = effective.stage || 'IDLE';

  let branch = effective.branch || '';
  let branchStatus = branch ? `recorded ${branch}` : 'none';
  if (branch && typeof client.getBranch === 'function') {
    try {
      const remote = await client.getBranch(owner, name, branch);
      const sha = remote?.commit?.sha || remote?.sha || '';
      if (!sha) {
        branchStatus = `${branch} (not on remote)`;
        problems.push(`Branch: remote ${branch} was not found`);
      } else {
        branchStatus = `${branch} (${sha.slice(0, 12)})`;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      branchStatus = `${branch} (lookup failed)`;
      problems.push(`Branch: ${msg}`);
    }
  }

  let prStatus = effective.prNumber ? `#${effective.prNumber}` : 'none';
  try {
    const pulls = typeof client.listPullsForIssue === 'function'
      ? await client.listPullsForIssue(owner, name, n)
      : [];
    if (pulls.length) {
      prStatus = `#${pulls[0].number}`;
    } else if (effective.prNumber) {
      problems.push(`PR: state has #${effective.prNumber} but GitHub returned none for this issue`);
    }
  } catch (e) {
    problems.push(`PR: ${e instanceof Error ? e.message : String(e)}`);
  }

  let githubCi = effective.githubCi || 'UNKNOWN';
  if (effective.prNumber || effective.commitSha || effective.branch) {
    try {
      const sync = await readGithubCiStatus({ client, owner, name, state: effective });
      githubCi = sync.githubCi;
    } catch (e) {
      problems.push(`GitHub CI: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let runners = { found: false, online: false, detail: 'UNKNOWN' };
  try {
    const probed = await probeGithubRepo(client, owner, name);
    runners = probed.runners || summarizeAiRunners({ runners: [] });
    if (!runners.online) problems.push(`Runner availability: ${runners.detail}`);
  } catch (e) {
    runners = { found: false, online: false, detail: e instanceof Error ? e.message : String(e) };
    problems.push(`Runner availability: ${runners.detail}`);
  }

  return {
    repository: slug,
    issue: n,
    stage,
    branch: branchStatus,
    pr: prStatus,
    localTests: effective.localTests || 'UNKNOWN',
    githubCi,
    config: configText,
    authentication: auth.ok ? `OK (${auth.detail})` : `ACTION REQUIRED — ${auth.detail}`,
    runners: runners.detail,
    workflowPermissions,
    stateFile: existsSync(stateFile) ? stateFile : `missing (${stateFile})`,
    problems,
    state: effective,
  };
}

export function formatIssueDoctor(report) {
  const problems = report.problems?.length
    ? report.problems.map(p => `- ${p}`).join('\n')
    : 'none';
  const lines = [
    `Repository: ${report.repository}`,
    `Issue: ${report.issue}`,
    `Stage: ${report.stage}`,
    `Branch: ${report.branch}`,
    `PR: ${report.pr}`,
    `Local tests: ${report.localTests}`,
    `GitHub CI: ${report.githubCi}`,
    `Config: ${report.config}`,
    `Authentication: ${report.authentication}`,
  ];
  if (report.workflowPermissions) {
    lines.push(`CI observation: ${report.workflowPermissions.detail}`);
  }
  lines.push('Problems:', problems);
  return lines.join('\n');
}

