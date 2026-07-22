# Qaizle

Portable GitHub Actions PR check that generates a **Copilot-powered reviewer quiz**.

## What it does

For each pull request, the workflow:
- reads the PR diff,
- asks GitHub Copilot/GitHub Models to generate **5 reviewer questions**,
- ensures each question is **multiple choice with at least 4 labeled options (A, B, C, D)**,
- posts (or updates) a styled PR comment with the questions and collapsible answers,
- creates a **GitHub Check Run** ("Copilot PR Quiz") that stays _in progress_ until the reviewer submits answers.

### Submitting answers

A reviewer replies to the quiz comment with a single line:

```
/quiz-answers A B C D A
```

One letter per question (A–D), space-separated.  After posting, the bot:
1. **Replies with a result table** showing ✅ Correct / ❌ Wrong for each answer and reveals the correct option for each wrong answer.
2. **Updates the Check Run** to `success` (pass) or `failure` (fail) based on the configured threshold.

### Blocking a PR

The `pass-threshold` input sets the minimum number of correct answers required (default **3 out of 5**).  
To make this a hard gate, go to your repository's **Settings → Branches → Branch protection rules** and add **"Copilot PR Quiz"** as a required status check.  The PR can then only be merged once the reviewer has answered the quiz with a passing score.

## Prerequisites

- A GitHub plan/account with access to **Copilot / GitHub Models**.
- Workflow permissions for:
  - `pull-requests: write`
  - `issues: write`
  - `contents: read`
  - `models: read`
  - `checks: write`

## Included files

| File | Purpose |
|------|---------|
| `.github/workflows/copilot-pr-quiz.yml` | Workflow: generates quiz on PR open/update and evaluates `/quiz-answers` comments |
| `.github/scripts/pr-quiz.mjs` | Script: calls GitHub Models to generate quiz, posts comment, creates check run |
| `.github/scripts/pr-quiz-evaluate.mjs` | Script: parses answer submission, posts result comment, updates check run |

The workflow runs automatically on `pull_request` events and answer evaluation runs on `issue_comment` events.  It can also be called as a reusable workflow (`workflow_call`).

## Workflow inputs

| Input | Default | Description |
|-------|---------|-------------|
| `pr-number` | _(required for workflow_call)_ | Pull request number to analyze |
| `repository` | current repo | Repository in `owner/name` format |
| `model` | `openai/gpt-4.1-mini` | GitHub Models / Copilot model identifier |
| `max-files` | `30` | Maximum changed files to include in analysis |
| `pass-threshold` | `3` | Minimum correct answers to pass (0 = no gate) |

## Portability

To reuse in another repository, copy all three files:
1. `.github/workflows/copilot-pr-quiz.yml`
2. `.github/scripts/pr-quiz.mjs`
3. `.github/scripts/pr-quiz-evaluate.mjs`

Then commit all three files in the target repository.  Both quiz generation and answer evaluation will work automatically.

### Reusable workflow usage

GitHub does not forward `issue_comment` events into a reusable workflow. To use Qaizle from another repository, add both jobs below to the caller repository. The first job generates the quiz through the reusable workflow; the second receives answer comments and invokes Qaizle's evaluation action.

> The `permissions` block is required. Without it, GitHub can run the workflow but cannot post the multiple-choice quiz, result, or check run.

```yaml
name: PR Quiz

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: write

jobs:
  qaizle-quiz:
    if: github.event_name == 'pull_request' && github.event.pull_request.draft == false
    uses: <owner>/<repo>/.github/workflows/copilot-pr-quiz.yml@main
    with:
      pr-number: ${{ github.event.pull_request.number }}
      repository: ${{ github.repository }}
      model: openai/gpt-4.1-mini
      pass-threshold: 3

  qaizle-evaluate:
    if: >
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request != null &&
      contains(github.event.comment.body, '/quiz-answers')
    runs-on: ubuntu-latest
    steps:
      - uses: <owner>/<repo>/.github/actions/evaluate-quiz@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          repository: ${{ github.repository }}
          pr-number: ${{ github.event.issue.number }}
          comment-body: ${{ github.event.comment.body }}
          commenter-login: ${{ github.event.comment.user.login }}
```

Replace `<owner>/<repo>` with this repository (for example, `pabes74/Qaizle`) and keep `@main` so the latest Qaizle workflow is used. The quiz is text-based because GitHub PR comments do not provide interactive multiple-choice controls. Submit answers with `/quiz-answers A B C D A`; Qaizle then posts the green ✅ / red ❌ result and updates the required check.
