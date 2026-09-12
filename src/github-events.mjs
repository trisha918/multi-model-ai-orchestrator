import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { issueStatePath } from './github-state.mjs';

export const GITHUB_EVENT_ACTIONS = Object.freeze([
  'issue_received',
  'authorization_checked',
  'implementation_started',
  'implementation_completed',
  'local_tests_completed',
  'push_started',
  'push_completed',
  'pr_created',
  'ci_started',
  'ci_completed',
  'human_review_required',
]);

export function isGithubEventAction(action) {
  return GITHUB_EVENT_ACTIONS.includes(action);
}

export function issueEventsPath(repo, issueNumber, env = process.env) {
  return issueStatePath(repo, issueNumber, env).replace(/\.json$/i, '.events.jsonl');
}

export function createGithubEvent({
  timestamp,
  repository = '',
  issue = 0,
  stage = '',
  action,
  result = '',
} = {}) {
  if (!isGithubEventAction(action)) {
    throw new Error(`Unknown GitHub automation event action: ${action}`);
  }
  return {
    timestamp: timestamp || new Date().toISOString(),
    repository: String(repository || ''),
    issue: Number(issue) || 0,
    stage: String(stage || ''),
    action,
    result: result == null ? '' : String(result),
  };
}

export function createGithubEventLog({
  now = () => new Date().toISOString(),
  persistPath = '',
} = {}) {
  const records = [];

  async function emit(fields) {
    const event = createGithubEvent({ ...fields, timestamp: fields.timestamp || now() });
    records.push(event);
    if (persistPath) {
      try {
        await mkdir(path.dirname(persistPath), { recursive: true });
        await appendFile(persistPath, `${JSON.stringify(event)}\n`, 'utf8');
      } catch {
        /* observability must not fail the run */
      }
    }
    return event;
  }

  return { records, emit };
}

export function actionsOf(records = []) {
  return records.map(e => e.action);
}
