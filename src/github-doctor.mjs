import { findOnPath } from './tooling.mjs';
import { detectGithubAuth } from './github-client.mjs';
import { loadRepoAutomationConfig, isIssueAutomationActive } from './github-config.mjs';
import { LABEL_DEFINITIONS } from './github-labels.mjs';
import { installationInfo } from './paths.mjs';

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
