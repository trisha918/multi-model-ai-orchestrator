export function workerPrompts(task) {
  const t = String(task);
  return {
    coding: `Work on this repository task end-to-end: ${t}\nRead AGENTS.md if present. Make only relevant changes. Do not commit or push. Finish with a concise summary of changes. Independent tests will be run by the orchestrator.`,
    geminiAnalysis: `You are the analysis/review agent for this repository. Read relevant repository files. Task: ${t}\nReturn a concise, actionable answer.`,
    plan: `Act as a senior software architect. READ ONLY. Do NOT modify files. Create an implementation plan for this task: ${t}\nInclude risks, files likely affected, and verification steps. Keep it practical for another coding agent.`,
    implementation: (planText) => `Implement this task: ${t}\n\nA planning agent produced this plan:\n---\n${planText}\n---\nRead AGENTS.md if present. Validate the plan against the actual code. Make only relevant changes. Do not commit or push. Independent tests will be run by the orchestrator.`,
    review: (ctx = {}) => buildGeminiReviewPrompt({ task: t, ...ctx }),
    fixHeader: `The original task is: ${t}`,
  };
}

export function buildGeminiReviewPrompt({
  task,
  worktree,
  planText = '',
  testsSummary = '',
  gitDiff = '',
}) {
  const t = String(task);
  const wt = String(worktree || '').trim();
  return [
    'Act as a strict code reviewer.',
    '',
    'You are reviewing the repository located at:',
    wt || '(worktree path missing)',
    '',
    'Review ONLY the current isolated worktree for this run.',
    'Do not inspect or modify the source workspace or orchestrator repository.',
    'Do not use any other directory, previous project, parent folder, or previous run worktree.',
    '',
    'READ ONLY. DO NOT MODIFY FILES. DO NOT RUN DESTRUCTIVE COMMANDS.',
    '',
    'Original task:',
    t,
    '',
    planText ? `Cursor plan:\n---\n${planText}\n---` : '',
    testsSummary ? `Independent test result:\n${testsSummary}` : '',
    gitDiff ? `Current git status/diff from that worktree:\n---\n${gitDiff}\n---` : '',
    '',
    'Check correctness, security, missing tests, regressions, and scope creep against THIS worktree only.',
    'Your FIRST non-empty line MUST be exactly one of:',
    'PASS',
    'NEEDS_FIXES',
    'If NEEDS_FIXES, follow it with concrete, actionable fixes. If PASS, briefly state why.',
  ].filter(s => s !== undefined).join('\n');
}

export function promptContainsExactTask(prompt, task) {
  return String(prompt).includes(String(task));
}
