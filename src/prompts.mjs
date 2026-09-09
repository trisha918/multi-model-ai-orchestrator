export function workerPrompts(task) {
  const t = String(task);
  return {
    coding: `Work on this repository task end-to-end: ${t}\nRead AGENTS.md if present. Make only relevant changes. Do not commit or push. Finish with a concise summary of changes. Independent tests will be run by the orchestrator.`,
    geminiAnalysis: `You are the analysis/review agent for this repository. Read relevant repository files. Task: ${t}\nReturn a concise, actionable answer.`,
    plan: `Act as a senior software architect. READ ONLY. Do NOT modify files. Create an implementation plan for this task: ${t}\nInclude risks, files likely affected, and verification steps. Keep it practical for another coding agent.`,
    implementation: (planText) => `Implement this task: ${t}\n\nA planning agent produced this plan:\n---\n${planText}\n---\nRead AGENTS.md if present. Validate the plan against the actual code. Make only relevant changes. Do not commit or push. Independent tests will be run by the orchestrator.`,
    review: `Act as a strict code reviewer. The task was: ${t}\nReview the CURRENT repository state and git changes. READ ONLY. DO NOT MODIFY FILES. Check correctness, security, missing tests, regressions, and scope creep.\nYour FIRST non-empty line MUST be exactly one of:\nPASS\nNEEDS_FIXES\nIf NEEDS_FIXES, follow it with concrete, actionable fixes. If PASS, briefly state why.`,
    fixHeader: `The original task is: ${t}`,
  };
}

export function promptContainsExactTask(prompt, task) {
  return String(prompt).includes(String(task));
}
