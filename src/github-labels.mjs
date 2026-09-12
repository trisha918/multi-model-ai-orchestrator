export const TRIGGER_LABEL = 'ai-auto';
export const STOP_LABEL = 'ai-stop';

export const STATUS_LABELS = Object.freeze([
  'ai-ready',
  'ai-working',
  'ai-needs-test',
  'ai-test-failed',
  'ai-fixing',
  'ai-ready-to-merge',
  'ai-human-review',
  'ai-done',
  'ai-failed',
]);

export const ROUTE_LABELS = Object.freeze({
  'ai-team': 'TEAM',
  'ai-cursor': 'CURSOR',
  'ai-codex': 'CODEX',
  'ai-gemini': 'GEMINI',
});

export const MODEL_LABELS = Object.freeze({
  'ai-codex-sol': { worker: 'CODEX', alias: 'sol', selection: 'MANUAL' },
  'ai-codex-terra': { worker: 'CODEX', alias: 'terra', selection: 'MANUAL' },
  'ai-codex-luna': { worker: 'CODEX', alias: 'luna', selection: 'MANUAL' },
  'ai-gemini-flash-high': { worker: 'GEMINI', alias: 'flash-high', selection: 'MANUAL' },
  'ai-gemini-flash-medium': { worker: 'GEMINI', alias: 'flash-medium', selection: 'MANUAL' },
  'ai-gemini-flash-low': { worker: 'GEMINI', alias: 'flash-low', selection: 'MANUAL' },
  'ai-gemini-pro-high': { worker: 'GEMINI', alias: 'pro-high', selection: 'MANUAL' },
  'ai-gemini-pro-low': { worker: 'GEMINI', alias: 'pro-low', selection: 'MANUAL' },
});

export const REQUIRED_LIVE_LABELS = Object.freeze([
  TRIGGER_LABEL,
  STOP_LABEL,
  'ai-working',
  'ai-needs-test',
  'ai-test-failed',
  'ai-fixing',
  'ai-ready-to-merge',
  'ai-human-review',
  'ai-done',
  'ai-failed',
]);

export const LABEL_DEFINITIONS = Object.freeze([
  { name: TRIGGER_LABEL, color: '1d76db', description: 'Trusted maintainer trigger for optional AI automation' },
  { name: STOP_LABEL, color: 'b60205', description: 'Cancel GitHub AI automation after the current safe boundary' },
  { name: 'ai-ready', color: 'c5def5', description: 'Issue accepted; waiting to start AI automation' },
  { name: 'ai-working', color: 'fbca04', description: 'AI implementation in progress' },
  { name: 'ai-needs-test', color: 'f9d0c4', description: 'Waiting for local tests or GitHub CI' },
  { name: 'ai-test-failed', color: 'd93f0b', description: 'Local tests or GitHub CI failed' },
  { name: 'ai-fixing', color: 'e99695', description: 'AI fix round in progress' },
  { name: 'ai-ready-to-merge', color: '0e8a16', description: 'Ready for human merge (v1.1 never auto-merges)' },
  { name: 'ai-human-review', color: '5319e7', description: 'Automation stopped; human review required' },
  { name: 'ai-done', color: '0e8a16', description: 'Issue closed after human merge or completion' },
  { name: 'ai-failed', color: 'b60205', description: 'Automation failed before a merge-ready PR' },
  { name: 'ai-team', color: 'bfd4f2', description: 'Route: TEAM' },
  { name: 'ai-cursor', color: 'bfd4f2', description: 'Route: CURSOR with smart model' },
  { name: 'ai-codex', color: 'bfd4f2', description: 'Route: CODEX with smart model' },
  { name: 'ai-gemini', color: 'bfd4f2', description: 'Route: GEMINI with smart model' },
  { name: 'ai-codex-sol', color: 'c2e0c6', description: 'CODEX + manual Sol alias' },
  { name: 'ai-codex-terra', color: 'c2e0c6', description: 'CODEX + manual Terra alias' },
  { name: 'ai-codex-luna', color: 'c2e0c6', description: 'CODEX + manual Luna alias' },
  { name: 'ai-gemini-flash-high', color: 'c2e0c6', description: 'GEMINI + manual Flash High' },
  { name: 'ai-gemini-flash-medium', color: 'c2e0c6', description: 'GEMINI + manual Flash Medium' },
  { name: 'ai-gemini-flash-low', color: 'c2e0c6', description: 'GEMINI + manual Flash Low' },
  { name: 'ai-gemini-pro-high', color: 'c2e0c6', description: 'GEMINI + manual Pro High' },
  { name: 'ai-gemini-pro-low', color: 'c2e0c6', description: 'GEMINI + manual Pro Low' },
]);

export function normalizeLabelNames(labels) {
  const names = (labels || []).map(l => {
    if (typeof l === 'string') return l.trim();
    if (l && typeof l === 'object') return String(l.name || '').trim();
    return '';
  }).filter(Boolean);
  return [...new Set(names)];
}

export class RoutingConflictError extends Error {
  constructor(message, extras = {}) {
    super(message);
    this.name = 'RoutingConflictError';
    this.code = 'ROUTING_CONFLICT';
    this.details = extras;
  }
}

export function resolveIssueRouting(labels) {
  const names = normalizeLabelNames(labels);
  const routeHits = names.filter(n => Object.prototype.hasOwnProperty.call(ROUTE_LABELS, n));
  const modelHits = names.filter(n => Object.prototype.hasOwnProperty.call(MODEL_LABELS, n));

  if (routeHits.length > 1) {
    throw new RoutingConflictError(`Conflicting route labels: ${routeHits.join(', ')}`, { labels: routeHits });
  }
  if (modelHits.length > 1) {
    throw new RoutingConflictError(`Conflicting model labels: ${modelHits.join(', ')}`, { labels: modelHits });
  }

  let worker = 'AUTO';
  let model = 'AUTO';
  let modelAlias = '';
  let selection = 'AUTO';
  let mode = 'auto';

  if (routeHits.length === 1) {
    worker = ROUTE_LABELS[routeHits[0]];
    mode = worker.toLowerCase();
  }

  if (modelHits.length === 1) {
    const spec = MODEL_LABELS[modelHits[0]];
    if (routeHits.length === 1 && ROUTE_LABELS[routeHits[0]] !== spec.worker) {
      throw new RoutingConflictError(
        `Conflicting route and model labels: ${routeHits[0]} vs ${modelHits[0]}`,
        { labels: [...routeHits, ...modelHits] },
      );
    }
    worker = spec.worker;
    mode = spec.worker.toLowerCase();
    model = spec.alias;
    modelAlias = spec.alias;
    selection = spec.selection;
  }

  return {
    worker,
    mode,
    model,
    modelAlias,
    selection,
    trigger: names.includes(TRIGGER_LABEL),
    stop: names.includes(STOP_LABEL),
    labels: names,
  };
}

export function statusLabelForStage(stage) {
  const map = {
    STARTED: 'ai-ready',
    WORKING: 'ai-working',
    IMPLEMENTING: 'ai-working',
    LOCAL_TESTS: 'ai-needs-test',
    WAITING_FOR_CI: 'ai-needs-test',
    CI_FAILED: 'ai-test-failed',
    FIXING: 'ai-fixing',
    READY_FOR_HUMAN_MERGE: 'ai-ready-to-merge',
    HUMAN_REVIEW_REQUIRED: 'ai-human-review',
    CANCELLED: 'ai-human-review',
    DONE: 'ai-done',
    FAILED: 'ai-failed',
    BLOCKED: 'ai-failed',
    CONFLICT: 'ai-human-review',
  };
  return map[stage] || '';
}

export function reconcileStatusLabels(currentLabels, nextStatusLabel, { keepTrigger = true } = {}) {
  const names = normalizeLabelNames(currentLabels);
  const keep = names.filter(n => {
    if (STATUS_LABELS.includes(n)) return false;
    if (n === TRIGGER_LABEL) return keepTrigger;
    return true;
  });
  if (nextStatusLabel) keep.push(nextStatusLabel);
  if (keepTrigger && names.includes(TRIGGER_LABEL) && !keep.includes(TRIGGER_LABEL)) keep.push(TRIGGER_LABEL);
  return [...new Set(keep)];
}

export function labelDiff(currentLabels, desiredLabels) {
  const current = new Set(normalizeLabelNames(currentLabels));
  const desired = new Set(normalizeLabelNames(desiredLabels));
  return {
    add: [...desired].filter(n => !current.has(n)),
    remove: [...current].filter(n => !desired.has(n) && STATUS_LABELS.includes(n)),
  };
}
