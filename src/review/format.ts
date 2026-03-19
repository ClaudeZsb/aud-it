import type { PullRequestWebhookPayload } from '../types/github.js';
import type {
  FilteredFileSet,
  InlineReviewComment,
  PersistedReviewState,
  ReviewFinding,
  ReviewInputFile,
  ReviewMode,
  ReviewResult,
} from '../types/review.js';

const severityRank: Record<ReviewFinding['severity'], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function buildMarker(commitSha: string): string {
  return `<!-- audit-bot:commit=${commitSha} -->`;
}

function buildStateMarker(state: PersistedReviewState): string {
  const encoded = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  return `<!-- audit-bot:state=${encoded} -->`;
}

export function parsePersistedReviewState(body: string | null | undefined): PersistedReviewState | undefined {
  if (!body) {
    return undefined;
  }

  const match = /<!-- audit-bot:state=([A-Za-z0-9_-]+) -->/.exec(body);
  if (!match?.[1]) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) as PersistedReviewState;
    if (parsed.version !== 1 || typeof parsed.reviewedHeadSha !== 'string') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function buildPersistedReviewState(
  payload: PullRequestWebhookPayload,
  result: ReviewResult,
  commitSha: string,
  reviewMode: ReviewMode,
): PersistedReviewState {
  return {
    version: 1,
    reviewedHeadSha: commitSha,
    reviewedAt: new Date().toISOString(),
    reviewMode,
    baseBranch: payload.pull_request.base.ref,
    summary: result.summary,
    findings: result.findings,
  };
}

export function createReviewMarker(commitSha: string): string {
  return buildMarker(commitSha);
}

export function selectInlineComments(
  findings: ReviewFinding[],
  reviewFiles: ReviewInputFile[],
  minConfidence: number,
  maxInlineComments: number,
): InlineReviewComment[] {
  const commentableByPath = new Map(reviewFiles.map((file) => [file.path, new Set(file.commentableLines)]));

  return findings
    .filter((finding) => finding.confidence >= minConfidence)
    .filter((finding) => commentableByPath.get(finding.path)?.has(finding.line))
    .sort((left, right) => {
      const severityDifference = severityRank[left.severity] - severityRank[right.severity];
      if (severityDifference !== 0) {
        return severityDifference;
      }

      return right.confidence - left.confidence;
    })
    .slice(0, maxInlineComments)
    .map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: 'RIGHT',
      body: `**[${finding.severity}]** ${finding.title}\n\n${finding.body}\n\nConfidence: ${finding.confidence.toFixed(2)}`,
    }));
}

function formatFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) {
    return '- No high-confidence findings.';
  }

  return findings
    .map((finding, index) => `${index + 1}. **[${finding.severity}]** ${finding.title} ([${finding.path}:${finding.line}](${finding.path})) - confidence ${finding.confidence.toFixed(2)}\n${finding.body}`)
    .join('\n\n');
}

function formatList(items: string[], emptyMessage: string): string {
  if (items.length === 0) {
    return `- ${emptyMessage}`;
  }

  return items.map((item) => `- ${item}`).join('\n');
}

export function formatReviewBody(
  payload: PullRequestWebhookPayload,
  result: ReviewResult,
  filtered: FilteredFileSet,
  commitSha: string,
  reviewMode: ReviewMode,
): string {
  const findings = result.findings
    .slice()
    .sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || right.confidence - left.confidence);
  const state = buildPersistedReviewState(payload, result, commitSha, reviewMode);

  return [
    '## AI Audit Review',
    '',
    `PR: ${payload.pull_request.html_url}`,
    `Base: \`${payload.pull_request.base.ref}\``,
    `Head: \`${payload.pull_request.head.ref}\` @ \`${commitSha.slice(0, 12)}\``,
    `Mode: **${reviewMode}**`,
    `Verdict: **${result.summary.verdict}**`,
    '',
    result.summary.overview,
    '',
    '### Findings',
    formatFindings(findings),
    '',
    '### Risks To Double-Check',
    formatList(result.summary.risks, 'No additional risks called out.'),
    '',
    '### Suggested Tests',
    formatList(result.summary.tests, 'No extra tests suggested.'),
    '',
    '### Review Coverage',
    `- Reviewed files: ${filtered.included.length}`,
    `- Ignored files: ${filtered.ignored.length}`,
    `- Unsupported files: ${filtered.unsupported.length}`,
    `- Additional reviewable files skipped by cap: ${filtered.truncatedCount}`,
    '',
    buildMarker(commitSha),
    buildStateMarker(state),
  ].join('\n');
}

export function formatSkippedReviewBody(
  payload: PullRequestWebhookPayload,
  filtered: FilteredFileSet,
  commitSha: string,
  reviewMode: ReviewMode,
): string {
  const state = buildPersistedReviewState(payload, {
    summary: {
      overview: 'The bot skipped this PR because there were no reviewable diff hunks after applying ignore rules and GitHub patch constraints.',
      verdict: 'skipped',
      risks: [],
      tests: [],
    },
    findings: [],
  }, commitSha, reviewMode);

  return [
    '## AI Audit Review',
    '',
    `PR: ${payload.pull_request.html_url}`,
    `Mode: **${reviewMode}**`,
    'The bot skipped this PR because there were no reviewable diff hunks after applying ignore rules and GitHub patch constraints.',
    '',
    '### Review Coverage',
    `- Ignored files: ${filtered.ignored.length}`,
    `- Unsupported files: ${filtered.unsupported.length}`,
    '',
    buildMarker(commitSha),
    buildStateMarker(state),
  ].join('\n');
}
