import type { PullRequestWebhookPayload } from '../types/github.js';
import type { ReviewInputFile, ReviewRunContext } from '../types/review.js';

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

export function buildReviewInstructions(minConfidence: number): string {
  return [
    'You are an experienced software reviewer acting as an AI audit bot for GitHub pull requests.',
    'Review only the changed code shown in the diff.',
    'Prioritize bugs, security issues, behavioral regressions, broken assumptions, and missing tests.',
    'Ignore style nits, naming preferences, and speculative concerns unless they create real risk.',
    'Only emit findings that you believe are actionable and specific to the diff.',
    'Each finding must point to a changed line in the new file, using the new-file line number from the diff.',
    'Only choose line numbers from the listed commentable lines for each file.',
    `Do not emit low-confidence findings below ${minConfidence.toFixed(2)} confidence.`,
    'Return valid JSON matching the requested schema and nothing else.',
  ].join('\n');
}

export function buildQuestionInstructions(): string {
  return [
    'You are an experienced software reviewer helping with a GitHub pull request discussion.',
    'Answer the user question using only the provided pull request metadata, diff, and previous review context.',
    'If the answer cannot be determined from the provided context, say so clearly.',
    'Be concise, concrete, and technically precise.',
    'Do not invent files, line numbers, behavior, or test results that are not present in the provided context.',
  ].join('\n');
}

function buildPreviousReviewContext(context: ReviewRunContext): string {
  if (!context.previousReview) {
    return 'PREVIOUS_REVIEW: none';
  }

  const { state, fallbackReason } = context.previousReview;
  const findings = state.findings.length === 0
    ? '- none'
    : state.findings
      .map((finding) => `- [${finding.severity}] ${finding.path}:${finding.line} ${finding.title} (confidence ${finding.confidence.toFixed(2)})`)
      .join('\n');

  return [
    'PREVIOUS_REVIEW:',
    `PREVIOUS_REVIEWED_HEAD_SHA: ${state.reviewedHeadSha}`,
    `PREVIOUS_REVIEWED_AT: ${state.reviewedAt}`,
    `PREVIOUS_REVIEW_MODE: ${state.reviewMode}`,
    `PREVIOUS_VERDICT: ${state.summary.verdict}`,
    `PREVIOUS_OVERVIEW: ${truncateText(state.summary.overview, 1200)}`,
    `PREVIOUS_FALLBACK_REASON: ${fallbackReason ?? 'none'}`,
    'PREVIOUS_FINDINGS:',
    findings,
  ].join('\n');
}

export function buildReviewInput(
  payload: PullRequestWebhookPayload,
  files: ReviewInputFile[],
  context: ReviewRunContext,
): string {
  const prBody = truncateText(payload.pull_request.body ?? '', 4000);

  const fileSections = files.map((file) => {
    const commentableLines = file.commentableLines.length > 0 ? file.commentableLines.join(', ') : 'none';

    return [
      `FILE: ${file.path}`,
      `STATUS: ${file.status}`,
      `CHANGES: +${file.additions} -${file.deletions} total=${file.changes}`,
      `COMMENTABLE_NEW_LINES: ${commentableLines}`,
      `PATCH_TRUNCATED: ${file.patchTruncated}`,
      'PATCH:',
      file.patch,
    ].join('\n');
  });

  return [
    `REPOSITORY: ${payload.repository.full_name}`,
    `PR_NUMBER: ${payload.number}`,
    `PR_TITLE: ${payload.pull_request.title}`,
    `PR_AUTHOR: ${payload.pull_request.user.login}`,
    `PR_URL: ${payload.pull_request.html_url}`,
    `BASE_BRANCH: ${payload.pull_request.base.ref}`,
    `HEAD_BRANCH: ${payload.pull_request.head.ref}`,
    `HEAD_SHA: ${payload.pull_request.head.sha}`,
    `REVIEW_MODE: ${context.reviewMode}`,
    'PR_BODY:',
    prBody || '(empty)',
    '',
    buildPreviousReviewContext(context),
    '',
    'CHANGED_FILES:',
    fileSections.join('\n\n'),
  ].join('\n');
}

export function buildQuestionInput(
  payload: PullRequestWebhookPayload,
  files: ReviewInputFile[],
  context: ReviewRunContext,
  question: string,
): string {
  return [
    buildReviewInput(payload, files, context),
    '',
    'USER_QUESTION:',
    truncateText(question, 4000),
  ].join('\n');
}
