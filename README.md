# Qaizle

Portable GitHub Actions PR check that generates an **AI-powered reviewer quiz**, using either GitHub Copilot/GitHub Models or the Claude API.

## What it does

For each pull request, the workflow:
- reads the PR diff,
- asks GitHub Copilot/GitHub Models (default) or Claude to generate **5 reviewer questions**,
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

- For the default `copilot` provider: a GitHub plan/account with access to **Copilot / GitHub Models**, and workflow permissions for:
  - `pull-requests: write`
  - `issues: write`
  - `contents: read`
  - `models: read`
  - `checks: write`
- For the `claude` provider: the same permissions minus `models: read`, plus an **Anthropic API key** supplied as a secret (see [Choosing a provider](#choosing-a-provider)).
- For an OpenAI-compatible provider: `pull-requests: write`, `issues: write`, `contents: read`, and `checks: write`, plus an optional provider API key supplied as a secret (see [Use your own AI provider](#use-your-own-ai-provider)).

## Included files

| File | Purpose |
|------|---------|
| `.github/workflows/copilot-pr-quiz.yml` | Workflow: generates quiz on PR open/update and evaluates `/quiz-answers` comments |
| `.github/scripts/pr-quiz.mjs` | Script: calls GitHub Models, Claude, or an OpenAI-compatible provider to generate quiz, posts comment, creates check run |
| `.github/scripts/pr-quiz-evaluate.mjs` | Script: parses answer submission, posts result comment, updates check run |
| `.github/actions/generate-quiz/action.yml` | Composite action used by the reusable workflow to generate the quiz |
| `.github/actions/evaluate-quiz/action.yml` | Composite action for evaluating answer comments from another repository |

The workflow runs automatically on `pull_request` events and answer evaluation runs on `issue_comment` events.  It can also be called as a reusable workflow (`workflow_call`).

## Workflow inputs

| Input | Default | Description |
|-------|---------|-------------|
| `pr-number` | _(required for workflow_call)_ | Pull request number to analyze |
| `repository` | current repo | Repository in `owner/name` format |
| `model` | `openai/gpt-4.1-mini` | GitHub Models / Copilot model identifier, or model name for `ai-endpoint` |
| `max-files` | `30` | Maximum changed files to include in analysis |
| `pass-threshold` | `3` | Minimum correct answers to pass (0 = no gate) |
| `ai-endpoint` | _(empty = GitHub Models)_ | OpenAI-compatible base URL or full `/chat/completions` URL |
| `ai-auth-style` | `bearer` | `bearer` (`Authorization: Bearer <key>`) or `api-key` (`api-key: <key>` header, Azure OpenAI) |
| `ai-json-mode` | `auto` | Send `response_format: json_object`: `auto` (on for custom providers, retried without it if rejected), `on`, `off` |
| `provider` | `copilot` | Quiz generation provider: `copilot` (GitHub Models) or `claude` (Anthropic API) |
| `claude-model` | `claude-haiku-4-5` | Claude model identifier (used when `provider` is `claude`) |

| Secret | Description |
|--------|-------------|
| `ai-api-key` | API key for `ai-endpoint`. When omitted, the workflow's `GITHUB_TOKEN` is used against GitHub Models. |
| `anthropic-api-key` | Anthropic API key, required when `provider` is `claude`. |

## Use your own AI provider

By default Qaizle uses GitHub Models. To use your own AI, pass an endpoint, a model name and an API key (always from a repository or organization secret). Any provider with an **OpenAI-compatible `/chat/completions` API** works.

```yaml
jobs:
  qaizle-quiz:
    if: github.event_name == 'pull_request' && github.event.pull_request.draft == false
    uses: pabes74/Qaizle/.github/workflows/copilot-pr-quiz.yml@main
    with:
      pr-number: ${{ github.event.pull_request.number }}
      repository: ${{ github.repository }}
      ai-endpoint: https://api.openai.com/v1
      model: gpt-4.1-mini
    secrets:
      ai-api-key: ${{ secrets.QAIZLE_AI_API_KEY }}
```

Or use the composite action directly:

```yaml
    steps:
      - uses: pabes74/Qaizle/.github/actions/generate-quiz@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          repository: ${{ github.repository }}
          pr-number: ${{ github.event.pull_request.number }}
          ai-endpoint: https://api.anthropic.com/v1/
          ai-api-key: ${{ secrets.QAIZLE_AI_API_KEY }}
          model: claude-sonnet-5
```

| Provider | `ai-endpoint` | `ai-auth-style` | `model` example |
|----------|---------------|-----------------|-----------------|
| OpenAI | `https://api.openai.com/v1` | `bearer` | `gpt-4.1-mini` |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=<version>` | `api-key` | `<deployment>` |
| Anthropic (OpenAI-compatible endpoint) | `https://api.anthropic.com/v1/` | `bearer` | `claude-sonnet-5` |
| OpenRouter | `https://openrouter.ai/api/v1` | `bearer` | `<vendor>/<model>` |
| LiteLLM proxy | `https://<your-proxy>/v1` | `bearer` | your configured model name |
| Ollama / vLLM (self-hosted runner) | `http://localhost:11434/v1` | `bearer` (key optional) | `llama3.1` |

The `/chat/completions` suffix is added automatically when you pass a base URL. The comment footer shows which host generated the quiz. If the provider fails or returns invalid JSON, Qaizle retries once and then falls back to template questions, so the check is never blocked by an AI outage.

> **What about decision models such as Jev (typesafe.ai)?** Jev returns typed decisions (choice / score / probability) rather than free text and has no OpenAI-compatible API, so it cannot write quiz questions, options and rationales. It could be a good fit later as a *validator* that double-checks the generated answer key, but it is not supported as a quiz generator.

## Choosing a provider

- **`copilot` (default)** — uses GitHub Models with the workflow's own `GITHUB_TOKEN`; no extra secret needed, but the workflow must grant `models: read` (see [Prerequisites](#prerequisites)). If quiz generation fails (e.g. missing permission), Qaizle degrades gracefully: it posts a generic fallback quiz with a ⚠️ warning banner rather than failing the check.
- **`claude`** — calls the Claude API directly. Requires an Anthropic API key, supplied as a repository/organization secret and forwarded into the reusable workflow as `secrets.anthropic-api-key` (see the example below). Unlike the Copilot path, a misconfigured or failing Claude call **fails the check run and the Action step outright** — no quiz comment is posted — since an explicit choice of `claude` shouldn't silently degrade into a generic-looking quiz.
- **OpenAI-compatible provider** — set `ai-endpoint` and `model`, and pass `ai-api-key` from a repository or organization secret.

## Portability

To reuse in another repository, copy all three files:
1. `.github/workflows/copilot-pr-quiz.yml`
2. `.github/scripts/pr-quiz.mjs`
3. `.github/scripts/pr-quiz-evaluate.mjs`

Then commit all three files in the target repository.  Both quiz generation and answer evaluation will work automatically.

### Reusable workflow usage

GitHub does not forward `issue_comment` events into a reusable workflow. To use Qaizle from another repository, add both jobs below to the caller repository. The first job generates the quiz through the reusable workflow, which runs Qaizle's packaged generation action rather than looking for scripts in the caller repository. The second receives answer comments and invokes Qaizle's evaluation action.

> The `permissions` block is required. Without it, GitHub can run the workflow but cannot post the multiple-choice quiz, result, or check run. In particular, `models: read` is what lets Qaizle call GitHub Models to generate real, PR-specific questions using the workflow's own `GITHUB_TOKEN` — no separate API key or endpoint needed. If it's missing, quiz generation fails silently and Qaizle falls back to generic template questions.

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
  models: read
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
      # Optional: switch to Claude instead of Copilot/GitHub Models.
      # provider: claude
      # claude-model: claude-haiku-4-5
    # secrets:
    #   # Only needed when provider: claude — a repo/org secret holding your Anthropic API key.
    #   anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

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
