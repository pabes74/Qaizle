# Qaizle

Portable GitHub Actions PR check that generates a **Copilot-powered reviewer quiz**.

## What it does

For each pull request, the workflow:
- reads the PR diff,
- asks GitHub Copilot/GitHub Models to generate **5 reviewer questions**,
- ensures each question is **multiple choice with at least 4 options**,
- posts (or updates) a styled PR comment with collapsible suggested answers and rationales.

## Prerequisites

- A GitHub plan/account with access to **Copilot / GitHub Models**.
- Workflow permissions for:
  - `pull-requests: write`
  - `issues: write`
  - `contents: read`
  - `models: read`

## Included workflow

- Workflow: `.github/workflows/copilot-pr-quiz.yml`
- Script: `.github/scripts/pr-quiz.mjs`

It runs automatically on `pull_request` events and can also be called as a reusable workflow (`workflow_call`).

## Portability

To reuse in another repository, copy:
1. `.github/workflows/copilot-pr-quiz.yml`
2. `.github/scripts/pr-quiz.mjs`

Then commit both files in the target repository.

### Reusable workflow usage example

```yaml
name: PR Quiz

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  qaizle-quiz:
    uses: <owner>/<repo>/.github/workflows/copilot-pr-quiz.yml@main
    with:
      pr-number: ${{ github.event.pull_request.number }}
      repository: ${{ github.repository }}
      model: openai/gpt-4.1-mini
```
