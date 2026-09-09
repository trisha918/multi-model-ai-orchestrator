import { classifyTask } from './router.mjs';

const SIMPLE_PATTERNS = [
  /\bsimple\b/,
  /\btypo\b/,
  /\brename\b/,
  /\bcomment\b/,
  /\bquick\b/,
  /\btrivial\b/,
];

const HARD_PATTERNS = [
  /\bdebug\b/,
  /\bhard\b/,
  /\brace condition\b/,
  /\bdeadlock\b/,
  /\bcomplex\b/,
];

const CRITICAL_PATTERNS = [
  /\bcritical\b/,
  /\bhigh[- ]risk\b/,
  /\bproduction incident\b/,
  /\bsecurity review\b/,
  /\barchitect(?:ure|ural)?\b/,
  /معماری/,
  /ریسک بالا/,
];

function hits(text, patterns) {
  let n = 0;
  for (const re of patterns) {
    if (re.test(text)) n += 1;
  }
  return n;
}

export function desiredProfile(task, classification = classifyTask(task)) {
  const text = String(task || '').toLowerCase();
  const criticalHits = hits(text, CRITICAL_PATTERNS);
  const hardHits = hits(text, HARD_PATTERNS);
  const simpleHits = hits(text, SIMPLE_PATTERNS);

  if (criticalHits >= 1) return 'max';
  if (hardHits >= 1) return 'strong';
  if (simpleHits >= 1 && classification.complexity <= 6) return 'fast';
  if (classification.risk === 'high' && classification.complexity >= 8) return 'max';
  if (classification.complexity >= 7) return 'strong';
  if (classification.complexity <= 4) return 'fast';
  if (classification.complexity <= 6) return 'balanced';
  return 'strong';
}

export function teamStageProfiles(task, classification = classifyTask(task)) {
  const cap = desiredProfile(task, classification);
  if (cap === 'max') {
    return {
      plan: 'max',
      implementation: 'max',
      review: 'max',
      fix: 'strong',
    };
  }
  if (cap === 'strong') {
    return {
      plan: 'strong',
      implementation: 'strong',
      review: 'strong',
      fix: 'strong',
    };
  }
  if (cap === 'fast') {
    return {
      plan: 'balanced',
      implementation: 'fast',
      review: 'balanced',
      fix: 'balanced',
    };
  }
  return {
    plan: 'balanced',
    implementation: 'balanced',
    review: 'balanced',
    fix: 'balanced',
  };
}

export function modelReason(profile, { provider, manual, alias } = {}) {
  if (manual) return `Explicit model request (${alias || 'manual'})`;
  const map = {
    fast: 'Low-complexity or latency-sensitive work',
    balanced: 'Default coding quality/performance',
    strong: 'Difficult coding, debugging, or analysis',
    max: 'Critical, architectural, or high-risk work',
    auto: 'Provider auto / safe default',
  };
  return map[profile] || `Selected ${provider} ${profile}`;
}
