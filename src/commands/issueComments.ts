import { env } from '../config/env.js';
import { getInstallationOctokit } from '../github/client.js';
import {
  createIssueComment,
  createReviewCommentReply,
  findLatestPersistedReviewState,
  getPullRequest,
  listIssueComments,
  listPullRequestFiles,
  listPullRequestReviewComments,
} from '../github/pullRequests.js';
import { answerPullRequestQuestion } from '../openai/reviewer.js';
import { buildReviewInputFiles } from '../review/diff.js';
import { filterReviewableFiles } from '../review/filter.js';
import { runPullRequestReview } from '../review/runner.js';
import type {
  IssueComment,
  IssueCommentWebhookPayload,
  PullRequestReviewComment,
  PullRequestReviewCommentWebhookPayload,
  PullRequestWebhookPayload,
} from '../types/github.js';
import type {
  ConversationExchange,
  FilteredFileSet,
  ReviewInputFile,
  ReviewRunContext,
} from '../types/review.js';

const COMMAND_PREFIX = '/audit';
const MAX_CONVERSATION_EXCHANGES = 6;

type AuditAction =
  | { kind: 'help' }
  | { kind: 'review'; force: boolean }
  | { kind: 'summary' }
  | { kind: 'ask'; question: string };

type ParseResult =
  | { recognized: false }
  | { recognized: true; action: AuditAction }
  | { recognized: true; error: string };

interface InteractionRequest {
  installationId: number;
  repositoryFullName: string;
  owner: string;
  repo: string;
  pullNumber: number;
  threadKey: string;
  sourceCommentId: number;
  body: string;
  replyLogin: string;
  authorAssociation?: string;
  commentUserType?: string;
  senderType?: string;
  senderLogin?: string;
  buildPullRequestPayload: (
    octokit: ReturnType<typeof getInstallationOctokit>,
  ) => Promise<PullRequestWebhookPayload>;
  loadConversationHistory: (
    octokit: ReturnType<typeof getInstallationOctokit>,
  ) => Promise<ConversationExchange[]>;
  reply: (octokit: ReturnType<typeof getInstallationOctokit>, body: string) => Promise<void>;
}

interface ConversationReplyState {
  version: 1;
  threadKey: string;
  sourceCommentId: number;
  actionKind: AuditAction['kind'];
  repliedAt: string;
}

interface ConversationComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt?: string;
  threadKey: string;
}

function repoAllowed(fullName: string): boolean {
  return env.github.allowedRepos.length === 0 || env.github.allowedRepos.includes(fullName);
}

function isBotActor(type: string | undefined, login: string | undefined): boolean {
  if (type === 'Bot') {
    return true;
  }

  return typeof login === 'string' && login.endsWith('[bot]');
}

function interactionAllowed(login: string, authorAssociation: string | undefined): boolean {
  if (env.github.allowedInteractors.includes(login.toLowerCase())) {
    return true;
  }

  if (!authorAssociation) {
    return false;
  }

  return env.github.allowedAuthorAssociations.includes(authorAssociation.toUpperCase());
}

function formatList(items: string[], emptyMessage: string): string {
  if (items.length === 0) {
    return `- ${emptyMessage}`;
  }

  return items.map((item) => `- ${item}`).join('\n');
}

function preferredMention(): string {
  const configured = env.github.botHandle?.trim();
  if (!configured) {
    return '@bot';
  }

  return configured.startsWith('@') ? configured : `@${configured}`;
}

function formatHelpReply(login: string): string {
  const mention = preferredMention();
  return [
    `@${login}`,
    '',
    'You can talk to me by mentioning me in the main PR conversation or in an inline review thread.',
    '',
    'Examples:',
    `- \`${mention} review\``,
    `- \`${mention} review force\``,
    `- \`${mention} summary\``,
    `- \`${mention} what is the riskiest part of this PR?\``,
    '',
    'Legacy `/audit ...` commands still work as a fallback.',
  ].join('\n');
}

function formatSummaryReply(login: string, state: Awaited<ReturnType<typeof findLatestPersistedReviewState>>): string {
  if (!state) {
    return [
      `@${login}`,
      '',
      'I have not posted a stored review for this PR yet.',
      '',
      `Mention me with \`${preferredMention()} review\` to create one.`,
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
      `Use \`${preferredMention()} review force\` if you want me to rerun on the same commit.`,
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

function formatInteractionErrorReply(login: string, message: string): string {
  return [
    `@${login}`,
    '',
    message,
    '',
    `Try \`${preferredMention()} help\` for examples.`,
  ].join('\n');
}

function formatFailureReply(login: string): string {
  return [
    `@${login}`,
    '',
    'I hit an error while handling that request.',
    '',
    'Please try again in a moment. If it keeps failing, check the bot logs.',
  ].join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function botAliases(): string[] {
  const handle = env.github.botHandle?.trim().replace(/^@/, '');
  if (!handle) {
    return [];
  }

  const aliases = new Set<string>();
  aliases.add(handle);

  if (handle.endsWith('[bot]')) {
    aliases.add(handle.slice(0, -'[bot]'.length));
  } else {
    aliases.add(`${handle}[bot]`);
  }

  return [...aliases].filter(Boolean);
}

function extractMentionPrompt(body: string): string | undefined {
  const aliases = botAliases();
  if (aliases.length === 0) {
    return undefined;
  }

  let matched = false;
  let stripped = body;

  for (const alias of aliases) {
    const regex = new RegExp(`(^|\\s)@${escapeRegExp(alias)}(?=\\s|$|[.,:;!?])`, 'gi');
    if (regex.test(stripped)) {
      matched = true;
    }
    stripped = stripped.replace(regex, '$1');
  }

  if (!matched) {
    return undefined;
  }

  return stripped.trim();
}

function parseMentionAction(prompt: string): ParseResult {
  const trimmed = prompt.trim();
  if (trimmed === '') {
    return {
      recognized: true,
      action: { kind: 'help' },
    };
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === 'help') {
    return {
      recognized: true,
      action: { kind: 'help' },
    };
  }

  if (normalized === 'summary') {
    return {
      recognized: true,
      action: { kind: 'summary' },
    };
  }

  if (normalized === 'review') {
    return {
      recognized: true,
      action: { kind: 'review', force: false },
    };
  }

  if (normalized === 'review force' || normalized === 'review --force') {
    return {
      recognized: true,
      action: { kind: 'review', force: true },
    };
  }

  if (normalized.startsWith('ask ')) {
    return {
      recognized: true,
      action: { kind: 'ask', question: trimmed.slice(4).trim() },
    };
  }

  return {
    recognized: true,
    action: { kind: 'ask', question: trimmed },
  };
}

function parseLegacyCommand(body: string): ParseResult {
  const trimmed = body.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) {
    return { recognized: false };
  }

  const rest = trimmed.slice(COMMAND_PREFIX.length).trim();
  if (rest === '' || rest === 'help') {
    return {
      recognized: true,
      action: { kind: 'help' },
    };
  }

  if (rest === 'summary') {
    return {
      recognized: true,
      action: { kind: 'summary' },
    };
  }

  if (rest === 'review') {
    return {
      recognized: true,
      action: { kind: 'review', force: false },
    };
  }

  if (rest === 'review force' || rest === 'review --force') {
    return {
      recognized: true,
      action: { kind: 'review', force: true },
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
      action: { kind: 'ask', question },
    };
  }

  const commandName = rest.split(/\s+/, 1)[0] ?? rest;
  return {
    recognized: true,
    error: `Unknown command \`${commandName}\`.`,
  };
}

function parseInteraction(body: string): ParseResult {
  const mentionPrompt = extractMentionPrompt(body);
  if (mentionPrompt !== undefined) {
    return parseMentionAction(mentionPrompt);
  }

  return parseLegacyCommand(body);
}

function buildPullRequestPayload(
  installationId: number,
  repositoryFullName: string,
  owner: string,
  repo: string,
  pullNumber: number,
  pullRequest: Awaited<ReturnType<typeof getPullRequest>>,
): PullRequestWebhookPayload {
  return {
    action: 'comment_interaction',
    installation: { id: installationId },
    repository: {
      name: repo,
      full_name: repositoryFullName,
      owner: {
        login: owner,
      },
    },
    number: pullNumber,
    pull_request: pullRequest,
  };
}

function buildConversationReplyMarker(state: ConversationReplyState): string {
  const encoded = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  return `<!-- audit-bot:conversation=${encoded} -->`;
}

function parseConversationReplyState(body: string): ConversationReplyState | undefined {
  const match = /<!-- audit-bot:conversation=([A-Za-z0-9_-]+) -->/.exec(body);
  if (!match?.[1]) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) as ConversationReplyState;
    if (
      parsed.version !== 1 ||
      typeof parsed.threadKey !== 'string' ||
      typeof parsed.sourceCommentId !== 'number' ||
      typeof parsed.actionKind !== 'string'
    ) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

function stripConversationReplyMarker(body: string): string {
  return body.replace(/\n?<!-- audit-bot:conversation=[A-Za-z0-9_-]+ -->\s*$/g, '').trim();
}

function sanitizeReplyBodyForHistory(body: string): string {
  const withoutMarker = stripConversationReplyMarker(body);
  return withoutMarker.replace(/^@[^\s]+\s*\n+/, '').trim();
}

function promptForHistory(parsed: ParseResult): string | undefined {
  if (!parsed.recognized || 'error' in parsed) {
    return undefined;
  }

  switch (parsed.action.kind) {
    case 'help':
      return undefined;
    case 'summary':
      return `${preferredMention()} summary`;
    case 'review':
      return parsed.action.force ? `${preferredMention()} review force` : `${preferredMention()} review`;
    case 'ask':
      return parsed.action.question;
  }
}

function sortConversationComments(comments: ConversationComment[]): ConversationComment[] {
  return comments
    .slice()
    .sort((left, right) => {
      const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
      const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }

      return left.id - right.id;
    });
}

function buildConversationHistory(comments: ConversationComment[], threadKey: string): ConversationExchange[] {
  const sorted = sortConversationComments(comments);
  const byId = new Map(sorted.map((comment) => [comment.id, comment]));

  return sorted
    .flatMap((comment) => {
      const state = parseConversationReplyState(comment.body);
      if (!state || state.threadKey !== threadKey) {
        return [];
      }

      const sourceComment = byId.get(state.sourceCommentId);
      if (!sourceComment) {
        return [];
      }

      const parsedSource = parseInteraction(sourceComment.body);
      const prompt = promptForHistory(parsedSource);
      if (!prompt) {
        return [];
      }

      return [{
        askedBy: sourceComment.userLogin,
        prompt,
        reply: sanitizeReplyBodyForHistory(comment.body),
        ...(state.repliedAt ? { createdAt: state.repliedAt } : {}),
      }];
    })
    .slice(-MAX_CONVERSATION_EXCHANGES);
}

function normalizeIssueConversationComments(pullNumber: number, comments: IssueComment[]): ConversationComment[] {
  return comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    userLogin: comment.user.login,
    threadKey: `pr:${pullNumber}`,
    ...(comment.created_at ? { createdAt: comment.created_at } : {}),
  }));
}

function normalizeReviewConversationComments(comments: PullRequestReviewComment[]): ConversationComment[] {
  return comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    userLogin: comment.user.login,
    threadKey: `review:${comment.in_reply_to_id ?? comment.id}`,
    ...(comment.created_at ? { createdAt: comment.created_at } : {}),
  }));
}

async function replyWithMetadata(
  request: InteractionRequest,
  octokit: ReturnType<typeof getInstallationOctokit>,
  body: string,
  actionKind: AuditAction['kind'],
): Promise<void> {
  const marker = buildConversationReplyMarker({
    version: 1,
    threadKey: request.threadKey,
    sourceCommentId: request.sourceCommentId,
    actionKind,
    repliedAt: new Date().toISOString(),
  });

  await request.reply(octokit, `${body}\n\n${marker}`);
}

async function handleInteraction(request: InteractionRequest): Promise<void> {
  if (isBotActor(request.commentUserType, request.replyLogin) || isBotActor(request.senderType, request.senderLogin)) {
    return;
  }

  const parsed = parseInteraction(request.body);
  if (!parsed.recognized) {
    return;
  }

  if (!interactionAllowed(request.replyLogin, request.authorAssociation)) {
    return;
  }

  const octokit = getInstallationOctokit(request.installationId);

  if (!repoAllowed(request.repositoryFullName)) {
    await request.reply(
      octokit,
      formatInteractionErrorReply(request.replyLogin, 'This repository is not allowed by `GITHUB_ALLOWED_REPOS`.'),
    );
    return;
  }

  try {
    if ('error' in parsed) {
      await request.reply(octokit, formatInteractionErrorReply(request.replyLogin, parsed.error));
      return;
    }

    if (parsed.action.kind === 'help') {
      await request.reply(octokit, formatHelpReply(request.replyLogin));
      return;
    }

    const pullRequestPayload = await request.buildPullRequestPayload(octokit);

    if (parsed.action.kind === 'summary') {
      const state = await findLatestPersistedReviewState(
        octokit,
        request.owner,
        request.repo,
        request.pullNumber,
      );
      await replyWithMetadata(
        request,
        octokit,
        formatSummaryReply(request.replyLogin, state),
        parsed.action.kind,
      );
      return;
    }

    if (parsed.action.kind === 'review') {
      const result = await runPullRequestReview(pullRequestPayload, {
        force: parsed.action.force,
        allowDraft: true,
        enforceBaseBranch: false,
      });

      await replyWithMetadata(
        request,
        octokit,
        formatReviewReply(request.replyLogin, result),
        parsed.action.kind,
      );
      return;
    }

    const previousState = await findLatestPersistedReviewState(
      octokit,
      request.owner,
      request.repo,
      request.pullNumber,
    );
    const files = await listPullRequestFiles(octokit, request.owner, request.repo, request.pullNumber);
    const filtered = filterReviewableFiles(files, env.review.ignorePatterns, env.review.maxFiles);

    if (filtered.included.length === 0) {
      await request.reply(
        octokit,
        formatInteractionErrorReply(
          request.replyLogin,
          'There are no reviewable diff hunks available for this PR right now.',
        ),
      );
      return;
    }

    const reviewFiles = buildReviewInputFiles(filtered.included, env.review.maxPatchChars);
    const context: ReviewRunContext = previousState
      ? {
        reviewMode: previousState.reviewedHeadSha === pullRequestPayload.pull_request.head.sha
          ? previousState.reviewMode
          : 'full',
        previousReview: { state: previousState },
      }
      : { reviewMode: 'full' };
    const history = await request.loadConversationHistory(octokit);

    const answer = await answerPullRequestQuestion(
      pullRequestPayload,
      reviewFiles,
      context,
      parsed.action.question,
      history,
    );

    await replyWithMetadata(
      request,
      octokit,
      formatAnswerReply(request.replyLogin, parsed.action.question, answer, filtered, reviewFiles),
      parsed.action.kind,
    );
  } catch (error) {
    console.error('comment interaction failed');
    console.error(error);

    try {
      await request.reply(octokit, formatFailureReply(request.replyLogin));
    } catch (replyError) {
      console.error('failed to post comment interaction error reply');
      console.error(replyError);
    }
  }
}

export async function handleIssueCommentEvent(payload: IssueCommentWebhookPayload): Promise<void> {
  if (payload.action !== 'created') {
    return;
  }

  if (!payload.issue.pull_request || !payload.installation?.id) {
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.issue.number;
  const installationId = payload.installation.id;
  const threadKey = `pr:${pullNumber}`;

  await handleInteraction({
    installationId,
    repositoryFullName: payload.repository.full_name,
    owner,
    repo,
    pullNumber,
    threadKey,
    sourceCommentId: payload.comment.id,
    body: payload.comment.body,
    replyLogin: payload.comment.user.login,
    ...(payload.comment.author_association ? { authorAssociation: payload.comment.author_association } : {}),
    ...(payload.comment.user.type ? { commentUserType: payload.comment.user.type } : {}),
    ...(payload.sender?.type ? { senderType: payload.sender.type } : {}),
    ...(payload.sender?.login ? { senderLogin: payload.sender.login } : {}),
    buildPullRequestPayload: async (octokit) => {
      const pullRequest = await getPullRequest(octokit, owner, repo, pullNumber);
      return buildPullRequestPayload(
        installationId,
        payload.repository.full_name,
        owner,
        repo,
        pullNumber,
        pullRequest,
      );
    },
    loadConversationHistory: async (octokit) => {
      const comments = await listIssueComments(octokit, owner, repo, pullNumber);
      return buildConversationHistory(normalizeIssueConversationComments(pullNumber, comments), threadKey);
    },
    reply: (octokit, body) => createIssueComment(octokit, owner, repo, pullNumber, body),
  });
}

export async function handlePullRequestReviewCommentEvent(
  payload: PullRequestReviewCommentWebhookPayload,
): Promise<void> {
  if (payload.action !== 'created' || !payload.installation?.id) {
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.pull_request.number;
  const topLevelCommentId = payload.comment.in_reply_to_id ?? payload.comment.id;
  const installationId = payload.installation.id;
  const threadKey = `review:${topLevelCommentId}`;

  await handleInteraction({
    installationId,
    repositoryFullName: payload.repository.full_name,
    owner,
    repo,
    pullNumber,
    threadKey,
    sourceCommentId: payload.comment.id,
    body: payload.comment.body,
    replyLogin: payload.comment.user.login,
    ...(payload.comment.author_association ? { authorAssociation: payload.comment.author_association } : {}),
    ...(payload.comment.user.type ? { commentUserType: payload.comment.user.type } : {}),
    ...(payload.sender?.type ? { senderType: payload.sender.type } : {}),
    ...(payload.sender?.login ? { senderLogin: payload.sender.login } : {}),
    buildPullRequestPayload: async (octokit) => {
      const pullRequest = await getPullRequest(octokit, owner, repo, pullNumber);
      return buildPullRequestPayload(
        installationId,
        payload.repository.full_name,
        owner,
        repo,
        pullNumber,
        pullRequest,
      );
    },
    loadConversationHistory: async (octokit) => {
      const comments = await listPullRequestReviewComments(octokit, owner, repo, pullNumber);
      return buildConversationHistory(normalizeReviewConversationComments(comments), threadKey);
    },
    reply: (octokit, body) => createReviewCommentReply(octokit, owner, repo, pullNumber, topLevelCommentId, body),
  });
}
