import { env } from '../config/env.js';
import { getInstallationOctokit } from '../github/client.js';
import {
  compareCommitFiles,
  createPullRequestReview,
  findLatestPersistedReviewState,
  hasReviewMarker,
  listPullRequestFiles,
} from '../github/pullRequests.js';
import { reviewPullRequestWithAI } from '../openai/reviewer.js';
import type { PullRequestWebhookPayload } from '../types/github.js';
import type { PullRequestFile } from '../types/github.js';
import type { PreviousReviewContext, ReviewMode, ReviewRunContext } from '../types/review.js';
import { buildReviewInputFiles } from './diff.js';
import { filterReviewableFiles } from './filter.js';
import {
  createReviewMarker,
  formatReviewBody,
  formatSkippedReviewBody,
  selectInlineComments,
} from './format.js';

const REVIEWABLE_ACTIONS = new Set(['opened', 'synchronize', 'ready_for_review', 'reopened']);

function repoAllowed(fullName: string): boolean {
  return env.github.allowedRepos.length === 0 || env.github.allowedRepos.includes(fullName);
}

function baseBranchAllowed(branch: string): boolean {
  return env.github.allowedBaseBranches.includes(branch);
}

async function resolveReviewFiles(
  octokit: ReturnType<typeof getInstallationOctokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  commitSha: string,
  previousState: Awaited<ReturnType<typeof findLatestPersistedReviewState>>,
): Promise<{ files: PullRequestFile[]; context: ReviewRunContext }> {
  if (!previousState || previousState.reviewedHeadSha === commitSha) {
    return {
      files: await listPullRequestFiles(octokit, owner, repo, pullNumber),
      context: { reviewMode: 'full' },
    };
  }

  let previousReview: PreviousReviewContext | undefined = { state: previousState };

  try {
    const compared = await compareCommitFiles(octokit, owner, repo, previousState.reviewedHeadSha, commitSha);
    if (compared.status === 'ahead' || compared.status === 'identical') {
      return {
        files: compared.files,
        context: {
          reviewMode: 'incremental',
          previousReview,
        },
      };
    }

    previousReview = {
      state: previousState,
      fallbackReason: `Falling back to full review because commit history status is ${compared.status}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown compare error';
    previousReview = {
      state: previousState,
      fallbackReason: `Falling back to full review because incremental compare failed: ${message}.`,
    };
  }

  return {
    files: await listPullRequestFiles(octokit, owner, repo, pullNumber),
    context: {
      reviewMode: 'full',
      previousReview,
    },
  };
}

export async function reviewPullRequestEvent(payload: PullRequestWebhookPayload): Promise<void> {
  if (!REVIEWABLE_ACTIONS.has(payload.action)) {
    return;
  }

  if (env.review.ignoreDrafts && payload.pull_request.draft) {
    return;
  }

  if (!payload.installation?.id) {
    return;
  }

  if (!repoAllowed(payload.repository.full_name)) {
    return;
  }

  if (!baseBranchAllowed(payload.pull_request.base.ref)) {
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.number;
  const commitSha = payload.pull_request.head.sha;
  const marker = createReviewMarker(commitSha);
  const octokit = getInstallationOctokit(payload.installation.id);

  if (await hasReviewMarker(octokit, owner, repo, pullNumber, marker)) {
    return;
  }

  const previousState = await findLatestPersistedReviewState(octokit, owner, repo, pullNumber);
  const { files, context } = await resolveReviewFiles(octokit, owner, repo, pullNumber, commitSha, previousState);
  const filtered = filterReviewableFiles(files, env.review.ignorePatterns, env.review.maxFiles);

  if (filtered.included.length === 0) {
    await createPullRequestReview(
      octokit,
      owner,
      repo,
      pullNumber,
      commitSha,
      formatSkippedReviewBody(payload, filtered, commitSha, context.reviewMode),
      [],
    );
    return;
  }

  const reviewFiles = buildReviewInputFiles(filtered.included, env.review.maxPatchChars);
  const aiResult = await reviewPullRequestWithAI(payload, reviewFiles, context);
  const findings = aiResult.findings.filter((finding) => finding.confidence >= env.review.minConfidence);
  const result = {
    ...aiResult,
    findings,
  };

  const inlineComments = env.review.summaryOnly
    ? []
    : selectInlineComments(result.findings, reviewFiles, env.review.minConfidence, env.review.maxInlineComments);

  await createPullRequestReview(
    octokit,
    owner,
    repo,
    pullNumber,
    commitSha,
    formatReviewBody(payload, result, filtered, commitSha, context.reviewMode),
    inlineComments,
  );
}
