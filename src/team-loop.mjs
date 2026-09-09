/**
 * Extracted TEAM auto-fix loop control. Live Gemini NEEDS_FIXES is not deterministic;
 * this function is the bounded-loop contract used by the orchestrator.
 */
export function teamLoopShouldStartFix({ testsStatus, decision, round, maxFixRounds }) {
  if (round >= maxFixRounds) return false;
  if (decision === 'NEEDS_FIXES') return true;
  if (testsStatus === 'FAIL' || testsStatus === 'TIMEOUT') return true;
  return false;
}
