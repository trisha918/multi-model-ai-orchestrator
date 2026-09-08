const ROUTES = ['CURSOR', 'CODEX', 'GEMINI', 'TEAM'];

const TEAM_PATTERNS = [
  /\barchitecture\b/,
  /\barchitect\b/,
  /\bcomplex refactor/,
  /\brefactor entire\b/,
  /\bredesign\b/,
  /\bmigration\b/,
  /\bauthenticate|\bauthentication\b/,
  /\bauthorization\b/,
  /\bauth(n|z)? system\b/,
  /\boauth\b/,
  /\brbac\b/,
  /\bmany (files|modules)\b/,
  /\bacross (many|multiple) (files|modules|services)\b/,
  /\bhigh[- ]risk\b/,
  /\brace condition\b/,
  /\bproduction incident\b/,
  /معماری/,
  /بازطراحی/,
  /احراز هویت/,
  /مهاجرت/,
  /کل پروژه/,
  /ریسک بالا/,
];

const GEMINI_PATTERNS = [
  /\banaly[sz]e\b/,
  /\breview\b/,
  /\baudit\b/,
  /\binvestigate\b/,
  /\bexplain architecture\b/,
  /\bcodebase analysis\b/,
  /\barchitecture analysis\b/,
  /\bdocumentation analysis\b/,
  /\bsecurity review\b/,
  /\blarge[- ]context\b/,
  /\bread[- ]only\b/,
  /تحلیل/,
  /بررسی/,
  /ممیزی/,
  /ارزیابی/,
];

const CURSOR_PATTERNS = [
  /\bui\b/,
  /\bux\b/,
  /\bcss\b/,
  /\bscss\b/,
  /\bfrontend\b/,
  /\bfront-end\b/,
  /\breact\b/,
  /\bvue\b/,
  /\bcomponent\b/,
  /\blayout\b/,
  /\bpage\b/,
  /\bform\b/,
  /\bresponsive\b/,
  /\bstyling\b/,
  /\bhtml\b/,
  /\bquick edit\b/,
  /\btypo\b/,
  /\brename\b/,
  /\breadme\b/,
  /\bdocs?\b/,
  /\bdocumentation\b/,
  /فرانت/,
  /رابط کاربری/,
  /کامپوننت/,
  /صفحه/,
  /فرم/,
  /ریسپانسیو/,
  /مستند/,
  /تایپو/,
];

const CODEX_PATTERNS = [
  /\bbug\b/,
  /\bfix\b/,
  /\bimplement/,
  /\bimplementation\b/,
  /\bunit tests?\b/,
  /\badd tests?\b/,
  /\btests?\b/,
  /\bbackend\b/,
  /\bapi\b/,
  /\bendpoint\b/,
  /\brefactor\b/,
  /\bdebug\b/,
  /\bvalidation\b/,
  /\bfunction\b/,
  /\berror\b/,
  /باگ/,
  /رفع/,
  /پیاده‌سازی/,
  /تست/,
];

function countMatches(text, patterns) {
  let n = 0;
  for (const re of patterns) {
    if (re.test(text)) n += 1;
  }
  return n;
}

function riskFrom(route, teamHits, geminiHits) {
  if (route === 'TEAM' || teamHits >= 2) return 'high';
  if (route === 'GEMINI' && geminiHits >= 1) return 'medium';
  if (route === 'CODEX') return 'medium';
  return 'low';
}

function complexityFrom({ teamHits, geminiHits, cursorHits, codexHits, route }) {
  let score = 3;
  score += teamHits * 2;
  score += geminiHits;
  score += Math.min(2, cursorHits);
  score += Math.min(2, codexHits);
  if (route === 'TEAM') score = Math.max(score, 8);
  if (route === 'GEMINI') score = Math.max(score, 6);
  if (route === 'CODEX') score = Math.max(score, 4);
  return Math.max(1, Math.min(10, score));
}

function pickRoute(scores, task) {
  const ordered = ROUTES.slice().sort((a, b) => scores[b] - scores[a] || ROUTES.indexOf(b) - ROUTES.indexOf(a));
  const best = ordered[0];
  if (scores[best] === 0) {
    return {
      route: 'CURSOR',
      reason: 'General development / quick-edit default for Cursor Auto',
    };
  }

  if (scores.TEAM > 0 && scores.TEAM >= scores.GEMINI && (scores.TEAM >= 5 || /\b(implement|refactor|change|add|build)\b/.test(task))) {
    if (/\b(review|audit|analy[sz]e|investigate)\b/.test(task) && !/\b(implement|fix|refactor|add|change|build)\b/.test(task)) {
      return {
        route: 'GEMINI',
        reason: 'Read-only analysis/review is a better fit than a full team workflow',
      };
    }
    return {
      route: 'TEAM',
      reason: 'High-risk or cross-cutting work needs planning, implementation, and independent review',
    };
  }

  if (scores.GEMINI >= scores.CURSOR && scores.GEMINI >= scores.CODEX && scores.GEMINI > 0) {
    return {
      route: 'GEMINI',
      reason: 'Repository analysis / review / large-context investigation',
    };
  }

  if (scores.CURSOR > scores.CODEX) {
    return {
      route: 'CURSOR',
      reason: 'UI, CSS, frontend, or general Cursor Auto development work',
    };
  }

  if (scores.CODEX > 0) {
    return {
      route: 'CODEX',
      reason: 'Focused coding, bugfix, tests, backend, or limited-scope implementation',
    };
  }

  return {
    route: best,
    reason: 'Highest weighted routing signals',
  };
}

export function normalizeMode(mode) {
  const m = String(mode || 'auto').trim().toLowerCase();
  if (m === 'agy') return 'gemini';
  if (m === 'auto' || m === 'cursor' || m === 'codex' || m === 'gemini' || m === 'team') return m;
  return '';
}

export function routeToLabel(route) {
  return String(route || '').toUpperCase();
}

export function classifyTask(task) {
  const text = String(task || '').toLowerCase();
  const teamHits = countMatches(text, TEAM_PATTERNS);
  const geminiHits = countMatches(text, GEMINI_PATTERNS);
  const cursorHits = countMatches(text, CURSOR_PATTERNS);
  const codexHits = countMatches(text, CODEX_PATTERNS);

  const scores = {
    TEAM: teamHits * 5,
    GEMINI: geminiHits * 4,
    CURSOR: cursorHits * 3,
    CODEX: codexHits * 3,
  };

  const picked = pickRoute(scores, text);
  const risk = riskFrom(picked.route, teamHits, geminiHits);
  const complexity = complexityFrom({ teamHits, geminiHits, cursorHits, codexHits, route: picked.route });
  const total = scores.TEAM + scores.GEMINI + scores.CURSOR + scores.CODEX;
  const winner = scores[picked.route] || 0;
  const second = Math.max(...ROUTES.filter(r => r !== picked.route).map(r => scores[r]));
  let confidence = 0.55;
  if (total === 0) confidence = 0.55;
  else {
    confidence = winner / (total + 1);
    if (winner - second >= 5) confidence = Math.min(0.99, confidence + 0.12);
    if (picked.route === 'TEAM') confidence = Math.max(confidence, 0.72);
  }
  confidence = Math.round(Math.max(0.4, Math.min(0.99, confidence)) * 100) / 100;

  return {
    route: picked.route,
    reason: picked.reason,
    risk,
    complexity,
    confidence,
    scores,
  };
}

export function resolveRoute(task, requestedMode) {
  const mode = normalizeMode(requestedMode);
  if (!mode) {
    throw new Error('Invalid --mode. Use auto, cursor, codex, gemini, agy, or team.');
  }
  if (mode !== 'auto') {
    const route = routeToLabel(mode);
    return {
      route,
      reason: `Explicit --mode ${mode}`,
      risk: route === 'TEAM' ? 'high' : route === 'GEMINI' ? 'medium' : 'low',
      complexity: route === 'TEAM' ? 8 : route === 'GEMINI' ? 6 : route === 'CODEX' ? 5 : 4,
      confidence: 1,
    };
  }
  return classifyTask(task);
}

export function teamRoles() {
  return {
    plan: 'Cursor',
    implementation: 'Codex',
    review: 'Gemini',
  };
}
