/**
 * pr-quiz-evaluate.mjs
 *
 * Evaluates a reviewer's quiz answer submission posted as a PR comment in the
 * form `/quiz-answers A B C D A`, then:
 *  - Posts a result comment showing ✅ / ❌ per question.
 *  - Updates (or creates) the "Copilot PR Quiz" GitHub Check Run on the PR head
 *    commit to reflect pass / fail.
 *
 * Required environment variables:
 *   GITHUB_TOKEN      – token with pull-requests:write, issues:write, checks:write
 *   TARGET_REPOSITORY – "owner/repo"
 *   PR_NUMBER         – pull request number
 *   COMMENT_BODY      – raw body of the triggering comment
 *   COMMENTER_LOGIN   – GitHub login of the comment author
 */

const token = process.env.GITHUB_TOKEN;
const targetRepository = process.env.TARGET_REPOSITORY || process.env.GITHUB_REPOSITORY;
const prNumber = Number.parseInt(process.env.PR_NUMBER || '', 10);
const commentBody = process.env.COMMENT_BODY || '';
const commenterLogin = process.env.COMMENTER_LOGIN || '';

if (!token) throw new Error('Missing GITHUB_TOKEN');
if (!targetRepository || !targetRepository.includes('/')) throw new Error('TARGET_REPOSITORY must be owner/name');
if (!Number.isFinite(prNumber)) throw new Error('PR_NUMBER must be a valid pull request number');

const [owner, repo] = targetRepository.split('/');
const githubApiBase = 'https://api.github.com';
const quizMarker = '<!-- copilot-pr-quiz -->';
const checkRunName = 'Copilot PR Quiz';

const ghHeaders = {
  Accept: 'application/vnd.github+json',
  Authorization: `token ${token}`,
  'X-GitHub-Api-Version': '2022-11-28'
};

async function ghRequest(path, init = {}) {
  const response = await fetch(`${githubApiBase}${path}`, {
    ...init,
    headers: { ...ghHeaders, ...(init.headers || {}) }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API request failed (${response.status}) ${path}: ${text}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

/**
 * Parse the five answer letters from a `/quiz-answers A B C D A` comment.
 * Returns an array of 0-based indices [0=A, 1=B, …] or null if not found.
 */
function parseAnswers(body) {
  const match = body.match(/\/quiz-answers\s+((?:[A-Ea-e]\s*){4}[A-Ea-e])/i);
  if (!match) return null;
  const letters = match[1].trim().split(/\s+/).slice(0, 5);
  if (letters.length !== 5) return null;
  return letters.map((l) => l.toUpperCase().charCodeAt(0) - 65);
}

/**
 * Decode the base64-encoded quiz data embedded as an HTML comment:
 *   <!-- quiz-data-b64:BASE64 -->
 */
function extractQuizData(body) {
  const match = body.match(/<!-- quiz-data-b64:([A-Za-z0-9+/=]+) -->/);
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1], 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * Build the result comment body with a per-question ✅ / ❌ table.
 */
function renderResults(submittedAnswers, correctAnswers, score, minCorrect) {
  const passed = score >= minCorrect || minCorrect === 0;
  const mention = commenterLogin ? `@${commenterLogin} ` : '';
  const lines = [
    `## 📊 Quiz Results for ${mention}`,
    '',
    `**Score: ${score} / 5**${passed ? ' — ✅ Pass' : ' — ❌ Fail'}${minCorrect > 0 ? ` _(minimum required: ${minCorrect}/5)_` : ''}`,
    '',
    '| # | Your Answer | Result |',
    '|---|:-----------:|--------|'
  ];

  for (let i = 0; i < 5; i++) {
    const submitted = submittedAnswers[i];
    const correct = correctAnswers[i];
    const submittedLetter = submitted !== undefined ? String.fromCharCode(65 + submitted) : '?';
    const correctLetter = String.fromCharCode(65 + correct);
    const isCorrect = submitted === correct;
    const result = isCorrect
      ? '✅ Correct'
      : `❌ Wrong — correct answer: **${correctLetter}**`;
    lines.push(`| ${i + 1} | **${submittedLetter}** | ${result} |`);
  }

  lines.push('');
  if (passed) {
    lines.push('🎉 **Quiz passed!** You can proceed with your review.');
  } else {
    lines.push(
      `⛔ **Quiz failed.** Review the questions and resubmit with \`/quiz-answers A B C D A\`.`
    );
  }

  return lines.join('\n');
}

async function findExistingCheckRun(headSha) {
  try {
    const data = await ghRequest(
      `/repos/${owner}/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(checkRunName)}&per_page=1`
    );
    return data?.check_runs?.[0] ?? null;
  } catch {
    return null;
  }
}

async function upsertCheckRun(headSha, passed, score, minCorrect) {
  const conclusion = passed ? 'success' : 'failure';
  const title = passed ? `Quiz passed (${score}/5)` : `Quiz failed (${score}/5, minimum ${minCorrect})`;
  const summary = passed
    ? `Reviewer passed the PR quiz with a score of ${score}/5. ✅`
    : `Reviewer failed the PR quiz with a score of ${score}/5. Minimum required: ${minCorrect}/5. ❌`;

  const existing = await findExistingCheckRun(headSha);

  if (existing) {
    await ghRequest(`/repos/${owner}/${repo}/check-runs/${existing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'completed',
        conclusion,
        output: { title, summary }
      })
    });
    console.log(`Updated check run ${existing.id} → ${conclusion}`);
  } else {
    await ghRequest(`/repos/${owner}/${repo}/check-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: checkRunName,
        head_sha: headSha,
        status: 'completed',
        conclusion,
        output: { title, summary }
      })
    });
    console.log(`Created completed check run → ${conclusion}`);
  }
}

(async () => {
  // 1. Parse the submitted answers from the triggering comment
  const submittedAnswers = parseAnswers(commentBody);
  if (!submittedAnswers) {
    console.log('No valid /quiz-answers pattern found in comment. Nothing to do.');
    process.exit(0);
  }

  // 2. Find the quiz comment on this PR
  const comments = await ghRequest(
    `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`
  );
  const quizComment = comments.find(
    (c) => typeof c.body === 'string' && c.body.includes(quizMarker)
  );

  if (!quizComment) {
    console.log('No Copilot quiz comment found on this PR. Nothing to do.');
    process.exit(0);
  }

  // 3. Extract the embedded quiz data
  const quizData = extractQuizData(quizComment.body);
  if (!quizData || !Array.isArray(quizData.correctAnswers) || quizData.correctAnswers.length !== 5) {
    console.log('Could not extract valid quiz data from the quiz comment. Nothing to do.');
    process.exit(0);
  }

  const { correctAnswers, minCorrect = 3 } = quizData;

  // 4. Calculate score
  const score = submittedAnswers.filter((a, i) => a === correctAnswers[i]).length;
  const passed = score >= minCorrect || minCorrect === 0;

  // 5. Post result comment
  const resultBody = renderResults(submittedAnswers, correctAnswers, score, minCorrect);
  await ghRequest(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: resultBody })
  });
  console.log(`Posted quiz result comment (score ${score}/5, ${passed ? 'PASS' : 'FAIL'}).`);

  // 6. Update the check run
  const pr = await ghRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  if (pr?.head?.sha) {
    await upsertCheckRun(pr.head.sha, passed, score, minCorrect);
  }

  console.log(`Quiz evaluation complete for PR #${prNumber}: ${score}/5 (${passed ? 'PASS' : 'FAIL'}).`);
})();
