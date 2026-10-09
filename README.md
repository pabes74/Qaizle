# Qaizle

Portable GitHub Actions PR check that generates an **AI-powered reviewer quiz**, using either GitHub Copilot (via the Copilot CLI) or the Claude API.

## What it does

For each pull request, the workflow:
- reads the PR diff,
- asks GitHub Copilot (default) or Claude to generate **5 reviewer questions**,
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

- Workflow permissions for:
  - `pull-requests: write`
  - `issues: write`
  - `contents: read`
  - `checks: write`
- For the default `copilot` provider: a **GitHub Copilot subscription** and a fine-grained personal access token with the **Copilot Requests** permission, supplied as a secret (see [Setting up the Copilot token](#setting-up-the-copilot-token)).
- For the `claude` provider: an an **Anthropic API key** supplied as a secret (see [Choosing a provider](#choosing-a-provider)).
- For an OpenAI-compatible provider: `pull-requests: write`, `issues: write`, `contents: read`, and `checks: write`, plus an optional provider API key supplied as a secret (see [Use your own AI provider](#use-your-own-ai-provider)).

## Included files

| File | Purpose |
|------|---------|
| `.github/workflows/copilot-pr-quiz.yml` | Workflow: generates quiz on PR open/update and evaluates `/quiz-answers` comments |
| `.github/scripts/pr-quiz.mjs` | Script: calls the Copilot CLI, Claude, or an OpenAI-compatible provider to generate quiz, posts comment, creates check run |
| `.github/scripts/pr-quiz-evaluate.mjs` | Script: parses answer submission, posts result comment, updates check run |
| `.github/actions/generate-quiz/action.yml` | Composite action used by the reusable workflow to generate the quiz |
| `.github/actions/evaluate-quiz/action.yml` | Composite action for evaluating answer comments from another repository |

The workflow runs automatically on `pull_request` events and answer evaluation runs on `issue_comment` events.  It can also be called as a reusable workflow (`workflow_call`).

## Workflow inputs

| Input | Default | Description |
|-------|---------|-------------|
| `pr-number` | _(required for workflow_call)_ | Pull request number to analyze |
| `repository` | current repo | Repository in `owner/name` format |
| `model` | _(empty = Copilot CLI default)_ | Copilot CLI model, or model name for `ai-endpoint` (required there) |
| `max-files` | `30` | Maximum changed files to include in analysis |
| `pass-threshold` | `3` | Minimum correct answers to pass (0 = no gate) |
| `ai-endpoint` | _(empty = Copilot CLI)_ | OpenAI-compatible base URL or full `/chat/completions` URL |
| `ai-auth-style` | `bearer` | `bearer` (`Authorization: Bearer <key>`) or `api-key` (`api-key: <key>` header, Azure OpenAI) |
| `ai-json-mode` | `auto` | Send `response_format: json_object`: `auto` (on, retried without it if rejected), `on`, `off` |
| `provider` | `copilot` | Quiz generation provider: `copilot` (Copilot CLI, or `ai-endpoint` when set) or `claude` (Anthropic API) |
| `claude-model` | `claude-haiku-4-5` | Claude model identifier (used when `provider` is `claude`) |

| Secret | Description |
|--------|-------------|
| `copilot-token` | Fine-grained PAT with the **Copilot Requests** permission, used by the Copilot CLI. Falls back to a `COPILOT_GITHUB_TOKEN` secret in the repository running the workflow. |
| `ai-api-key` | API key for `ai-endpoint`. |
| `anthropic-api-key` | Anthropic API key, required when `provider` is `claude`. |

## Use your own AI provider

By default Qaizle uses the Copilot CLI. To use your own AI instead, pass an endpoint, a model name and an API key (always from a repository or organization secret). Any provider with an **OpenAI-compatible `/chat/completions` API** works.

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

- **`copilot` (default)** — installs the [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/automate-with-actions) on the runner and runs it non-interactively (`copilot -p ... --no-ask-user`, no tools allowed, in an empty directory). It uses your Copilot subscription, and each quiz consumes premium requests. It needs the `copilot-token` secret (see [Setting up the Copilot token](#setting-up-the-copilot-token)). If quiz generation fails (e.g. missing or expired token), Qaizle degrades gracefully: it posts a generic fallback quiz with a ⚠️ warning banner rather than failing the check.
- **`claude`** — calls the Claude API directly. Requires an Anthropic API key, supplied as a repository/organization secret and forwarded into the reusable workflow as `secrets.anthropic-api-key` (see the example below). Unlike the Copilot path, a misconfigured or failing Claude call **fails the check run and the Action step outright** — no quiz comment is posted — since an explicit choice of `claude` shouldn't silently degrade into a generic-looking quiz.
- **OpenAI-compatible provider** — set `ai-endpoint` and `model`, and pass `ai-api-key` from a repository or organization secret.

> **GitHub Models was retired on 2026-07-30.** Earlier Qaizle versions called `models.github.ai` with the workflow's `GITHUB_TOKEN` and the `models: read` permission. That endpoint now answers every request with a plain `OK`, which made every quiz fall back to the template questions. Remove `models: read` and `model: openai/gpt-4.1-mini` from your caller workflow and add the `copilot-token` secret instead.

### Setting up the Copilot token

The workflow's built-in `GITHUB_TOKEN` cannot use your Copilot subscription in a user-owned repository, so the Copilot CLI needs a personal access token:

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Under **Account permissions**, set **Copilot Requests** to *Read-only*. No repository permissions are needed. (Classic `ghp_` tokens are not supported.)
3. Add it as a repository (or organization) secret named `COPILOT_GITHUB_TOKEN` in each repository that runs Qaizle, e.g. `gh secret set COPILOT_GITHUB_TOKEN --repo <owner>/<repo>`.
4. Forward it to the reusable workflow with `secrets: copilot-token: ${{ secrets.COPILOT_GITHUB_TOKEN }}`, or to the composite action with `copilot-token: ${{ secrets.COPILOT_GITHUB_TOKEN }}`.

Set an expiry date on the token and renew it before it expires; an expired token produces the ⚠️ fallback quiz.

## Portability

To reuse in another repository, copy all three files:
1. `.github/workflows/copilot-pr-quiz.yml`
2. `.github/scripts/pr-quiz.mjs`
3. `.github/scripts/pr-quiz-evaluate.mjs`

Then commit all three files in the target repository.  Both quiz generation and answer evaluation will work automatically.

### Reusable workflow usage

GitHub does not forward `issue_comment` events into a reusable workflow. To use Qaizle from another repository, add both jobs below to the caller repository. The first job generates the quiz through the reusable workflow, which runs Qaizle's packaged generation action rather than looking for scripts in the caller repository. The second receives answer comments and invokes Qaizle's evaluation action.

> The `permissions` block is required. Without it, GitHub can run the workflow but cannot post the multiple-choice quiz, result, or check run. The `copilot-token` secret is what lets Qaizle generate real, PR-specific questions with your Copilot subscription. If it's missing or expired, Qaizle falls back to generic template questions with a ⚠️ banner.

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
      pass-threshold: 3
      # Optional: switch to Claude instead of Copilot.
      # provider: claude
      # claude-model: claude-haiku-4-5
    secrets:
      # Fine-grained PAT with the "Copilot Requests" permission (see "Setting up the Copilot token").
      copilot-token: ${{ secrets.COPILOT_GITHUB_TOKEN }}
      # Only needed when provider: claude — a repo/org secret holding your Anthropic API key.
      # anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

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
