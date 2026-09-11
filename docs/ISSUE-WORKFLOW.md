# Issue workflow example

Example: **Issue #42 — Fix checkout validation**.

## Issue body (untrusted task text)

```text
Problem: checkout validation accepts empty coupon codes.
Expected: empty coupons are rejected.
Acceptance: unit tests cover empty and whitespace codes.
Testing: npm test
```

Creating this Issue does **not** start AI.

## Maintainer

A repository OWNER adds label `ai-auto` (and optionally a route/model label).

- With **`review.required: false`**: `ai-auto` alone is enough; smart routing may pick a solo worker (`review: SKIP`).
- With **`review.required: true`**: add **`ai-auto` and `ai-team`**. Solo routes (`ai-codex`, `ai-cursor`, …) and `ai-auto` alone are rejected before workers — they cannot satisfy required independent review.

GitHub Actions concurrency key: `ai-issue-owner/app-42`.

Authorization reads **who applied the label** from GitHub events/API, not the Issue body.

## Transitions

| Step | Stage | Labels (status) | Notes |
| --- | --- | --- | --- |
| 1 | STARTED / WORKING | `ai-auto`, `ai-working` | Comment: AI Automation — Started. Route CODEX. Attempt 1/5 |
| 2 | Isolated worktree | same | Branch `ai/issue-42-fix-checkout-validation` |
| 3 | LOCAL_TESTS | `ai-needs-test` | Independent local tests PASS |
| 4 | Push + PR | `ai-needs-test` | PR title `Fix #42: Fix checkout validation`. Body `Closes #42`. GitHub CI: PENDING (not claimed PASS) |
| 5 | CI FAIL | `ai-test-failed` | Comment: CI Failed. Next action: AI fix requested |
| 6 | FIXING | `ai-fixing` | Same branch. Attempt 2/5 |
| 7 | CI PASS | `ai-ready-to-merge` | Local Tests PASS, GitHub CI PASS. **No merge.** |

If five CI failures occur, status becomes `ai-human-review` with HUMAN REVIEW REQUIRED, last check, diagnosis, branch, and PR.

Humans merge the PR. After close, `ai-done` may be applied.

## First live test Issue (private repo)

See [GITHUB-LIVE-TEST.md](GITHUB-LIVE-TEST.md). Create **without** `ai-auto`:

Title: `Add multiply operation and tests`

Then a trusted maintainer adds `ai-auto` only (smart routing). The e2e example keeps `review.required: false` so a solo route can still reach PR + CI. Expected end: `ai-ready-to-merge`, PR still **OPEN**.
