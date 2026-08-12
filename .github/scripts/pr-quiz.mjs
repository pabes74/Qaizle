const token = process.env.GITHUB_TOKEN;
const targetRepository = process.env.TARGET_REPOSITORY || process.env.GITHUB_REPOSITORY;
const prNumber = Number.parseInt(process.env.PR_NUMBER || '', 10);
const model = process.env.QUIZ_MODEL || 'openai/gpt-4.1-mini';
const maxFiles = Number.parseInt(process.env.MAX_FILES || '30', 10);
const runUrl = process.env.RUN_URL || '';
const minCorrect = Math.max(0, Math.min(5, Number.parseInt(process.env.MIN_CORRECT || '3', 10)));
const checkRunName = 'Copilot PR Quiz';

if (!token) throw new Error('Missing GITHUB_TOKEN');
if (!targetRepository || !targetRepository.includes('/')) throw new Error('TARGET_REPOSITORY must be owner/name');
if (!Number.isFinite(prNumber)) throw new Error('PR_NUMBER must be a valid pull request number');

const [owner, repo] = targetRepository.split('/');
const githubApiBase = 'https://api.github.com';
const modelsEndpoint = process.env.MODELS_ENDPOINT || 'https://models.github.ai/inference/chat/completions';
const marker = '<!-- copilot-pr-quiz -->';

// Base prompt: keep quiz questions focused on the PR's overall goal(s), not per-file implementation details.
const QUIZ_SYSTEM_PROMPT =
  'You are a strict PR-review quiz generator. Your job is to test whether a reviewer understands the OVERALL GOAL(S) of a pull request — not implementation minutiae in any single file. Return only valid JSON with exactly 5 questions and at least 4 answer options each.';

const QUESTION_GUIDELINES = [
  'Create exactly 5 multiple-choice questions that test the reviewer\'s understanding of this PR at a high level.',
  'Requirements:',
  '- Question 1 must always ask about the overall goal/purpose of this PR as a whole (e.g. "What is this PR about?" / "What problem does this PR solve?").',
  '- If the changes serve multiple distinct goals or unrelated concerns, include one question asking the reviewer to identify that the PR bundles multiple goals, and what those goals are. If the PR has a single cohesive goal, use this slot for another high-level question about its overall scope or impact instead.',
  '- All other questions must stay at the level of overall intent, scope, and impact of the PR as a whole (e.g. what behavior changes, who/what is affected, why the change matters) — never about a single file, function, or line.',
  '- Do NOT create questions about implementation details specific to one file (e.g. "why was variable X renamed in file Y", "what does this specific function do", "what changed in this patch snippet").',
  '- Base your understanding of the goal(s) on the PR title, description, and the overall pattern of changes across files — not on any single file in isolation.',
  'Return strict JSON in this schema:',
  '{"questions":[{"question":"...","options":["...","...","...","..."],"correctOption":0,"rationale":"..."}]}'
].join('\n');

const ghHeaders = {
  Accept: 'application/vnd.github+json',
  Authorization: `token ${token}`,
  'X-GitHub-Api-Version': '2022-11-28'
};

async function ghRequest(path, init = {}) {
  const response = await fetch(`${githubApiBase}${path}`, {
    ...init,
    headers: {
      ...ghHeaders,
      ...(init.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API request failed (${response.status}) ${path}: ${text}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function sanitize(text, fallback = 'N/A') {
  if (!text || typeof text !== 'string') return fallback;
  return text.replace(/\r/g, '').trim() || fallback;
}

function parseJsonPayload(raw) {
  const clean = sanitize(raw, '{}').replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(clean);
}

function normalizeQuestions(payload) {
  if (!payload || !Array.isArray(payload.questions)) return [];

  return payload.questions
    .slice(0, 5)
    .map((question, index) => {
      const qText = sanitize(question?.question, `What is the main purpose of change #${index + 1}?`);
      const options = Array.isArray(question?.options)
        ? question.options
            .map((option) => sanitize(option, ''))
            .filter(Boolean)
            .slice(0, 6)
        : [];

      while (options.length < 4) {
        options.push(`Option ${String.fromCharCode(65 + options.length)}`);
      }

      const validAnswer = Number.isInteger(question?.correctOption) ? question.correctOption : 0;
      const answerIndex = Math.max(0, Math.min(validAnswer, options.length - 1));
      const rationale = sanitize(question?.rationale, 'Review the changed code paths and linked specification details.');

      return {
        question: qText,
        options,
        answerIndex,
        rationale
      };
    });
}

function fallbackQuestions() {
  return [
    {
      question: 'What is the most likely overall business or product goal of this PR?',
      options: [
        'To introduce a new user-facing behavior',
        'To refactor internals without behavior changes',
        'To fix a bug in existing behavior',
        'To improve non-functional quality (performance, reliability, or security)'
      ],
      answerIndex: 0,
      rationale: 'Confirm the PR description and acceptance criteria align with the selected goal.'
    },
    {
      question: 'Which scenario should the reviewer verify first to ensure the change matches the specification?',
      options: [
        'A happy-path scenario described in the issue/PR',
        'An unrelated edge case from another module',
        'Only lint/style checks with no functional validation',
        'A random manual test with no documented expectation'
      ],
      answerIndex: 0,
      rationale: 'Start with specification-backed behavior before deeper exploratory testing.'
    },
    {
      question: 'What is the clearest signal that AI-assisted code in this PR is aligned with requirements?',
      options: [
        'The change implements explicitly documented acceptance criteria',
        'The generated code compiles without tests',
        'The diff is large and touches many files',
        'The author confirms it was AI-generated'
      ],
      answerIndex: 0,
      rationale: 'Requirement traceability is stronger evidence than implementation size or source.'
    },
    {
      question: 'Which review artifact best proves the change purpose is understood by the reviewer?',
      options: [
        'A concise explanation of intent plus affected flows',
        'Approving quickly to keep delivery speed high',
        'Checking only formatting and naming conventions',
        'Focusing only on whether dependencies changed'
      ],
      answerIndex: 0,
      rationale: 'Clear articulation of intent and user impact demonstrates true understanding.'
    },
    {
      question: 'Which follow-up action is most appropriate if one quiz answer is uncertain?',
      options: [
        'Request clarification tied to a specific code hunk and spec point',
        'Approve anyway because CI passed',
        'Reject the PR without explanation',
        'Ignore the uncertainty if code style looks clean'
      ],
      answerIndex: 0,
      rationale: 'Specific clarification requests improve correctness and reviewer confidence.'
    }
  ];
}

function renderComment(questions) {
  const quizDataJson = JSON.stringify({
    correctAnswers: questions.map((q) => q.answerIndex),
    minCorrect
  });
  // Encode as base64 so special characters cannot accidentally break the HTML comment
  const quizDataEncoded = Buffer.from(quizDataJson).toString('base64');

  const lines = [
    marker,
    `<!-- quiz-data-b64:${quizDataEncoded} -->`,
    '## 🧠 Copilot Reviewer Quiz',
    '',
    '> 5 multiple-choice questions generated from the pull request diff to validate reviewer understanding.',
    ''
  ];

  if (minCorrect > 0) {
    lines.push(`> ⚠️ A minimum score of **${minCorrect} out of 5** correct answers is required to pass the quiz check.`);
    lines.push('');
  }

  questions.forEach((q, index) => {
    lines.push(`### ${index + 1}. ${q.question}`);
    lines.push('');
    q.options.forEach((option, optionIndex) => {
      const letter = String.fromCharCode(65 + optionIndex);
      lines.push(`- **${letter}.** ${option}`);
    });
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>💡 Reveal answer &amp; rationale</summary>');
    lines.push('');
    lines.push(`**Correct answer: ${String.fromCharCode(65 + q.answerIndex)}** ✅`);
    lines.push('');
    lines.push(`**Rationale:** ${q.rationale}`);
    lines.push('</details>');
    lines.push('');
  });

  lines.push('---');
  lines.push('');
  lines.push('### 📝 Submit your answers');
  lines.push('');
  lines.push('Reply to this comment with one letter (A–D) per question in order:');
  lines.push('');
  lines.push('```');
  lines.push('/quiz-answers A B C D A');
  lines.push('```');
  lines.push('');
  lines.push('> After submitting, a result comment will be posted showing ✅ / ❌ for each answer,');
  lines.push('> and the PR check will be updated accordingly.');
  lines.push('');
  lines.push('---');
  lines.push(`_Generated automatically by the Copilot PR Quiz workflow${runUrl ? ` ([run logs](${runUrl}))` : ''}._`);

  return lines.join('\n');
}

async function createPendingCheckRun(headSha) {
  if (!headSha) return;
  try {
    await ghRequest(`/repos/${owner}/${repo}/check-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: checkRunName,
        head_sha: headSha,
        status: 'in_progress',
        output: {
          title: 'Waiting for quiz answers',
          summary: `The reviewer quiz has been posted. Reply to the quiz comment with \`/quiz-answers A B C D A\` to submit answers.${minCorrect > 0 ? ` Minimum passing score: ${minCorrect}/5.` : ''}`
        }
      })
    });
    console.log(`Created pending check run "${checkRunName}" for SHA ${headSha}.`);
  } catch (error) {
    console.warn(`Could not create check run (non-fatal): ${error.message}`);
  }
}

async function upsertComment(body) {
  const comments = await ghRequest(`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`);
  const existing = comments.find((comment) => typeof comment.body === 'string' && comment.body.includes(marker));

  if (existing) {
    await ghRequest(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });
    return;
  }

  await ghRequest(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body })
  });
}

async function loadPullRequestContext() {
  const [pr, files] = await Promise.all([
    ghRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`),
    ghRequest(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${Math.max(1, Math.min(maxFiles, 100))}`)
  ]);

  const fileSummaries = files
    .map((file) => {
      const patch = sanitize(file.patch, '').slice(0, 1500);
      return `FILE: ${file.filename}\nSTATUS: ${file.status}\nADDITIONS: ${file.additions}\nDELETIONS: ${file.deletions}\nPATCH:\n${patch || '[patch omitted by GitHub API]'}`;
    })
    .join('\n\n');

  return {
    pr,
    files,
    prompt: [
      `Repository: ${owner}/${repo}`,
      `PR #${pr.number}: ${sanitize(pr.title)}`,
      `PR Description:\n${sanitize(pr.body, 'No description provided.')}`,
      '',
      'Changed files and patch excerpts:',
      fileSummaries,
      '',
      QUESTION_GUIDELINES
    ].join('\n')
  };
}

async function generateQuestions(prompt) {
  const response = await fetch(modelsEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      'api-key': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: QUIZ_SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Model request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  const parsed = parseJsonPayload(content);
  const questions = normalizeQuestions(parsed);

  if (questions.length !== 5) {
    throw new Error(`Expected 5 questions, received ${questions.length}`);
  }

  return questions;
}

(async () => {
  const { pr, prompt } = await loadPullRequestContext();

  let questions;
  try {
    questions = await generateQuestions(prompt);
  } catch (error) {
    console.warn(`Falling back to template questions: ${error.message}`);
    questions = fallbackQuestions();
  }

  const comment = renderComment(questions);
  await upsertComment(comment);
  await createPendingCheckRun(pr.head?.sha);

  console.log(`Posted Copilot reviewer quiz for PR #${pr.number} in ${owner}/${repo}.`);
})();
