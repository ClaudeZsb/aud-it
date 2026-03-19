import { env } from '../config/env.js';
import { getInstallationOctokit } from '../github/client.js';
import {
  createIssueComment,
  findLatestPersistedReviewState,
  getPullRequest,
  listPullRequestFiles,
} from '../github/pullRequests.js';
import { answerPullRequestQuestion } from '../openai/reviewer.js';
import { buildReviewInputFiles } from '../review/diff.js';
import { filterReviewableFiles } from '../review/filter.js';
import { runPullRequestReview } from '../review/runner.js';
import type { IssueCommentWebhookPayload, PullRequestWebhookPayload } from '../types/github.js';
import type { FilteredFileSet, ReviewInputFile, ReviewRunContext } from '../types/review.js';

const COMMAND_PREFIX = '/audit';

type AuditCommand =
  | { kind: 'help' }
  | { kind: 'review'; force: boolean }
  | { kind: 'summary' }
  | { kind: 'ask'; question: string };

type CommandParseResult =
  | { recognized: false }
  | { recognized: true; command: AuditCommand }
  | { recognized: true; error: string };

function repoAllowed(fullName: string): boolean {
  return env.github.allowedRepos.length === 0 || env.github.allowedRepos.includes(fullName);
}

function isBotActor(type: string | undefined, login: string | undefined): boolean {
  if (type === 'Bot') {
    return true;
  }

  return typeof login === 'string' && login.endsWith('[bot]');
}

function formatList(items: string[], emptyMessage: string): string {
  if (items.length === 0) {
    return `- ${emptyMessage}`;
  }

  return items.map((item) => `- ${item}`).join('\n');
}

function formatHelpReply(login: string): string {
  return [
    `@${login}`,
    '',
    'I support these PR comment commands:',
    '',
    '- `/audit help` - show this help message',
    '- `/audit review` - run a review if the current head has not already been reviewed',
    '- `/audit review force` - rerun a review on the current head even if it was already reviewed',
    '- `/audit summary` - show the latest stored review summary for this PR',
    '- `/audit ask <question>` - answer a question using the current PR diff and latest stored review context',
    '',
    'This first version only listens in the main PR conversation comments.',
  ].join('\n');
}

function formatSummaryReply(login: string, state: Awaited<ReturnType<typeof findLatestPersistedReviewState>>): string {
  if (!state) {
    return [
      `@${login}`,
      '',
      'I have not posted a stored review for this PR yet.',
      '',
      'Run `/audit review` to create one.',
    ].join('\n');
  }

  const findings = state.findings.length === 0
    ? '- No high-confidence findings in the latest stored review.'
    : state.findings
      .slice(0, 5)
      .map((finding, index) => `${index + 1}. **[${finding.severity}]** ${finding.title} - \`${finding.path}:${finding.line}\` (confidence ${finding.confidence.toFixed(2)})\n${finding.body}`)
      .join('\n\n');

  return [
    `@${login}`,
    '',
    `Latest stored review: \`${state.reviewedHeadSha.slice(0, 12)}\``,
    `- Reviewed at: ${state.reviewedAt}`,
    `- Mode: ${state.reviewMode}`,
    `- Verdict: ${state.summary.verdict}`,
    '',
    state.summary.overview,
    '',
    '### Findings',
    findings,
    '',
    '### Risks To Double-Check',
    formatList(state.summary.risks, 'No additional risks called out.'),
    '',
    '### Suggested Tests',
    formatList(state.summary.tests, 'No extra tests suggested.'),
  ].join('\n');
}

function formatReviewReply(
  login: string,
  result: Awaited<ReturnType<typeof runPullRequestReview>>,
): string {
  if (result.status === 'duplicate') {
    return [
      `@${login}`,
      '',
      `I already reviewed head \`${result.commitSha.slice(0, 12)}\`.`,
      '',
      'Use `/audit review force` if you want me to rerun on the same commit.',
    ].join('\n');
  }

  if (result.status === 'ignored') {
    return [
      `@${login}`,
      '',
      `I could not run a review: ${result.reason}.`,
    ].join('\n');
  }

  if (result.status === 'skipped-no-files') {
    return [
      `@${login}`,
      '',
      `I posted a skipped review for \`${result.commitSha.slice(0, 12)}\`.`,
      '',
      'There were no reviewable diff hunks after applying the ignore rules and GitHub patch constraints.',
    ].join('\n');
  }

  return [
    `@${login}`,
    '',
    `I reviewed \`${result.commitSha.slice(0, 12)}\` and posted the result as a PR review.`,
    `- Mode: ${result.reviewMode}`,
    `- Verdict: ${result.result.summary.verdict}`,
    `- Findings: ${result.result.findings.length}`,
  ].join('\n');
}

function buildCoverageNote(filtered: FilteredFileSet, reviewFiles: ReviewInputFile[]): string | undefined {
  const notes: string[] = [];
  const truncatedPatches = reviewFiles.filter((file) => file.patchTruncated).length;

  if (filtered.ignored.length > 0) {
    notes.push(`${filtered.ignored.length} ignored files`);
  }

  if (filtered.unsupported.length > 0) {
    notes.push(`${filtered.unsupported.length} unsupported files`);
  }

  if (filtered.truncatedCount > 0) {
    notes.push(`${filtered.truncatedCount} additional files omitted by the file cap`);
  }

  if (truncatedPatches > 0) {
    notes.push(`${truncatedPatches} patches truncated by the diff-size cap`);
  }

  if (notes.length === 0) {
    return undefined;
  }

  return `_Context note: ${notes.join('; ')}._`;
}

function formatAnswerReply(
  login: string,
  question: string,
  answer: string,
  filtered: FilteredFileSet,
  reviewFiles: ReviewInputFile[],
): string {
  const coverageNote = buildCoverageNote(filtered, reviewFiles);
  const lines = [
    `@${login}`,
    '',
    '**Question**',
    `> ${question.split('\n').join('\n> ')}`,
    '',
    '**Answer**',
    answer.trim() || 'I could not produce an answer from the available PR context.',
  ];

  if (coverageNote) {
    lines.push('', coverageNote);
  }

  return lines.join('\n');
}

function formatCommandErrorReply(login: string, message: string): string {
  return [
    `@${login}`,
    '',
    message,
    '',
    'Use `/audit help` to see the available commands.',
  ].join('\n');
}

function formatFailureReply(login: string): string {
  return [
    `@${login}`,
    '',
    'I hit an error while handling that command.',
    '',
    'Please try again in a moment. If it keeps failing, check the bot logs.',
  ].join('\n');
}

function parseAuditCommand(body: string): CommandParseResult {
  const trimmed = body.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) {
    return { recognized: false };
  }

  const rest = trimmed.slice(COMMAND_PREFIX.length).trim();
  if (rest === '' || rest === 'help') {
    return {
      recognized: true,
      command: { kind: 'help' },
    };
  }

  if (rest === 'summary') {
    return {
      recognized: true,
      command: { kind: 'summary' },
    };
  }

  if (rest === 'review') {
    return {
      recognized: true,
      command: { kind: 'review', force: false },
    };
  }

  if (rest === 'review force' || rest === 'review --force') {
    return {
      recognized: true,
      command: { kind: 'review', force: true },
    };
  }

  if (rest.startsWith('ask')) {
    const question = rest.slice('ask'.length).trim();
    if (!question) {
      return {
        recognized: true,
        error: 'Missing question. Usage: `/audit ask <question>`.',
      };
    }

    return {
      recognized: true,
      command: { kind: 'ask', question },
    };
  }

  const commandName = rest.split(/\s+/, 1)[0] ?? rest;
  return {
    recognized: true,
    error: `Unknown command \`${commandName}\`.`,
  };
}

function toPullRequestWebhookPayload(
  payload: IssueCommentWebhookPayload,
  pullRequest: Awaited<ReturnType<typeof getPullRequest>>,
): PullRequestWebhookPayload {
  return {
    action: 'comment_command',
    repository: payload.repository,
    number: payload.issue.number,
    pull_request: pullRequest,
    ...(payload.installation ? { installation: payload.installation } : {}),
    ...(payload.sender ? { sender: payload.sender } : {}),
  };
}

export async function handleIssueCommentEvent(payload: IssueCommentWebhookPayload): Promise<void> {
  if (payload.action !== 'created') {
    return;
  }

  if (!payload.issue.pull_request) {
    return;
  }

  if (isBotActor(payload.comment.user.type, payload.comment.user.login) || isBotActor(payload.sender?.type, payload.sender?.login)) {
    return;
  }

  const parsed = parseAuditCommand(payload.comment.body);
  if (!parsed.recognized) {
    return;
  }

  if (!payload.installation?.id) {
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.issue.number;
  const octokit = getInstallationOctokit(payload.installation.id);
  const replyLogin = payload.comment.user.login;

  if (!repoAllowed(payload.repository.full_name)) {
    await createIssueComment(
      octokit,
      owner,
      repo,
      pullNumber,
      formatCommandErrorReply(replyLogin, 'This repository is not allowed by `GITHUB_ALLOWED_REPOS`.'),
    );
    return;
  }

  try {
    if ('error' in parsed) {
      await createIssueComment(
        octokit,
        owner,
        repo,
        pullNumber,
        formatCommandErrorReply(replyLogin, parsed.error),
      );
      return;
    }

    if (parsed.command.kind === 'help') {
      await createIssueComment(octokit, owner, repo, pullNumber, formatHelpReply(replyLogin));
      return;
    }

    const pullRequest = await getPullRequest(octokit, owner, repo, pullNumber);
    const pullRequestPayload = toPullRequestWebhookPayload(payload, pullRequest);

    if (parsed.command.kind === 'summary') {
      const state = await findLatestPersistedReviewState(octokit, owner, repo, pullNumber);
      await createIssueComment(octokit, owner, repo, pullNumber, formatSummaryReply(replyLogin, state));
      return;
    }

    if (parsed.command.kind === 'review') {
      const result = await runPullRequestReview(pullRequestPayload, {
        force: parsed.command.force,
        allowDraft: true,
        enforceBaseBranch: false,
      });

      await createIssueComment(octokit, owner, repo, pullNumber, formatReviewReply(replyLogin, result));
      return;
    }

    const previousState = await findLatestPersistedReviewState(octokit, owner, repo, pullNumber);
    const files = await listPullRequestFiles(octokit, owner, repo, pullNumber);
    const filtered = filterReviewableFiles(files, env.review.ignorePatterns, env.review.maxFiles);

    if (filtered.included.length === 0) {
      await createIssueComment(
        octokit,
        owner,
        repo,
        pullNumber,
        formatCommandErrorReply(replyLogin, 'There are no reviewable diff hunks available for this PR right now.'),
      );
      return;
    }

    const reviewFiles = buildReviewInputFiles(filtered.included, env.review.maxPatchChars);
    const context: ReviewRunContext = previousState
      ? {
        reviewMode: previousState.reviewedHeadSha === pullRequest.head.sha ? previousState.reviewMode : 'full',
        previousReview: { state: previousState },
      }
      : { reviewMode: 'full' };

    const answer = await answerPullRequestQuestion(
      pullRequestPayload,
      reviewFiles,
      context,
      parsed.command.question,
    );

    await createIssueComment(
      octokit,
      owner,
      repo,
      pullNumber,
      formatAnswerReply(replyLogin, parsed.command.question, answer, filtered, reviewFiles),
    );
  } catch (error) {
    console.error('issue comment command failed');
    console.error(error);

    try {
      await createIssueComment(octokit, owner, repo, pullNumber, formatFailureReply(replyLogin));
    } catch (commentError) {
      console.error('failed to post issue comment command error reply');
      console.error(commentError);
    }
  }
}
