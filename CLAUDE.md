# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Qaizle is a portable GitHub Actions PR check. On PR open/update it asks GitHub Models (Copilot-backed) to generate a 5-question multiple-choice quiz about the PR's overall goal, posts it as a PR comment, and opens a pending "Copilot PR Quiz" check run. When a reviewer replies with `/quiz-answers A B C D A`, it scores the answers, posts a result comment, and completes the check run as `success`/`failure` based on a configurable pass threshold. There is no build step, package manager, or test suite — the whole project is two dependency-free Node scripts plus the Actions/workflow YAML that wires them together.

## Running/testing scripts locally

Scripts use only Node's built-in `fetch` (Node 20, matching the workflow's `setup-node`), so no `npm install` is needed. To exercise a script outside of Actions, set the same env vars the workflow sets and run it directly, e.g.:

```bash
GITHUB_TOKEN=ghp_xxx TARGET_REPOSITORY=owner/repo PR_NUMBER=123 \
  node .github/scripts/pr-quiz.mjs

GITHUB_TOKEN=ghp_xxx TARGET_REPOSITORY=owner/repo PR_NUMBER=123 \
  COMMENT_BODY='/quiz-answers A B C D A' COMMENTER_LOGIN=someuser \
  node .github/scripts/pr-quiz-evaluate.mjs
```

There is no lint/build/test command configured in this repo — verify changes by running the relevant script against a real (or scratch) PR, or by reading through the logic carefully since there's no automated coverage.

## Architecture

**Two independent scripts, triggered by two different GitHub events, coordinated only through a PR comment:**

- `.github/scripts/pr-quiz.mjs` — runs on `pull_request` (opened/synchronize/reopened/ready_for_review). Fetches the PR + changed files, builds a prompt (title, description, per-file patch excerpts truncated to 1500 chars), calls the GitHub Models inference endpoint, and normalizes the response into exactly 5 questions with 4+ options each. Falls back to a hardcoded question set (`fallbackQuestions()`) if the model call/parse fails twice. Shuffles each question's options (Fisher-Yates) so the correct answer isn't always first. Renders a markdown comment and **upserts** it (finds an existing comment by the `<!-- copilot-pr-quiz -->` HTML marker and PATCHes it, otherwise creates one) so re-runs on `synchronize` update the same comment instead of duplicating. Also opens an `in_progress` "Copilot PR Quiz" check run on the PR head SHA.
- `.github/scripts/pr-quiz-evaluate.mjs` — runs on `issue_comment` when the comment body contains `/quiz-answers`. Parses 5 answer letters via regex, finds the quiz comment by the same marker, and decodes the answer key from a **base64-encoded JSON blob embedded in an HTML comment** (`<!-- quiz-data-b64:... -->`) inside the quiz comment body. This is the only state storage mechanism — there's no database or artifact; the correct answers and `minCorrect` threshold travel round-trip inside the PR comment itself. Scores the submission, posts a results comment, and completes the check run (`success`/`failure`).

**Composite actions wrap these scripts for cross-repo reuse:**

- `.github/actions/generate-quiz/action.yml` and `.github/actions/evaluate-quiz/action.yml` invoke the scripts via `$GITHUB_ACTION_PATH/../../scripts/*.mjs` — i.e. relative to *this* repo's checkout of the action, not the caller repo's working directory. This is what lets another repository use Qaizle via `uses: pabes74/Qaizle/.github/actions/generate-quiz@main` without needing to check out or vendor the scripts.
- `.github/workflows/copilot-pr-quiz.yml` is both the workflow that runs directly in this repo (on `pull_request`/`issue_comment`) and a `workflow_call`-able reusable workflow other repos can invoke for quiz generation. Note GitHub does not forward `issue_comment` events through `workflow_call`, so answer evaluation in caller repos must call `evaluate-quiz` directly as a composite action (see the README's "Reusable workflow usage" section for the exact two-job pattern).

**Key invariants to preserve when editing:**
- The `<!-- copilot-pr-quiz -->` marker and `<!-- quiz-data-b64:... -->` comment format are the contract between the two scripts — changing one requires changing the other's parser.
- `pass-threshold`/`minCorrect` is clamped to `[0, 5]`; `0` means no gate (always passes).
- Quiz generation is intentionally scoped to the PR's *overall* goal rather than per-file implementation details — this is enforced through `QUIZ_SYSTEM_PROMPT`/`QUESTION_GUIDELINES` in `pr-quiz.mjs`, not through code structure, so prompt changes are the main lever for quiz quality/behavior.
