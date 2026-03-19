import { env } from '../config/env.js';
import { getInstallationOctokit } from '../github/client.js';
import {
  compareCommitFiles,
  createPullRequestReview,
  findLatestPersistedReviewState,
  listPullRequestFiles,
} from '../github/pullRequests.js';
import { reviewPullRequestWithAI } from '../openai/reviewer.js';
import type { PullRequestFile, PullRequestWebhookPayload } from '../types/github.js';
import type {
  PreviousReviewContext,
  ReviewMode,
  ReviewResult,
  ReviewRunContext,
} from '../types/review.js';
import { buildReviewInputFiles } from './diff.js';
import { filterReviewableFiles } from './filter.js';
import {
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

export interface RunPullRequestReviewOptions {
  force?: boolean;
  allowDraft?: boolean;
  enforceBaseBranch?: boolean;
}

export type RunPullRequestReviewResult =
  | {
    status: 'ignored';
    reason: string;
  }
  | {
    status: 'duplicate';
    commitSha: string;
  }
  | {
    status: 'skipped-no-files';
    commitSha: string;
    reviewMode: ReviewMode;
  }
  | {
    status: 'reviewed';
    commitSha: string;
    reviewMode: ReviewMode;
    result: ReviewResult;
  };

export async function runPullRequestReview(
  payload: PullRequestWebhookPayload,
  options: RunPullRequestReviewOptions = {},
): Promise<RunPullRequestReviewResult> {
  if (!payload.installation?.id) {
    return {
      status: 'ignored',
      reason: 'missing installation context',
    };
  }

  if (!repoAllowed(payload.repository.full_name)) {
    return {
      status: 'ignored',
      reason: 'repository is not allowed by configuration',
    };
  }

  if ((options.enforceBaseBranch ?? true) && !baseBranchAllowed(payload.pull_request.base.ref)) {
    return {
      status: 'ignored',
      reason: `base branch \`${payload.pull_request.base.ref}\` is not enabled for automatic review`,
    };
  }

  if (!options.allowDraft && env.review.ignoreDrafts && payload.pull_request.draft) {
    return {
      status: 'ignored',
      reason: 'draft pull requests are currently ignored',
    };
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.number;
  const commitSha = payload.pull_request.head.sha;
  const octokit = getInstallationOctokit(payload.installation.id);
  const previousState = await findLatestPersistedReviewState(octokit, owner, repo, pullNumber);

  if (!options.force && previousState?.reviewedHeadSha === commitSha) {
    return {
      status: 'duplicate',
      commitSha,
    };
  }

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
    return {
      status: 'skipped-no-files',
      commitSha,
      reviewMode: context.reviewMode,
    };
  }

  const reviewFiles = buildReviewInputFiles(filtered.included, env.review.maxPatchChars);
  const aiResult = await reviewPullRequestWithAI(payload, reviewFiles, context);
  const findings = aiResult.findings.filter((finding) => finding.confidence >= env.review.minConfidence);
  const result: ReviewResult = {
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

  return {
    status: 'reviewed',
    commitSha,
    reviewMode: context.reviewMode,
    result,
  };
}

export async function reviewPullRequestEvent(payload: PullRequestWebhookPayload): Promise<void> {
  if (!REVIEWABLE_ACTIONS.has(payload.action)) {
    return;
  }

  await runPullRequestReview(payload);
}
