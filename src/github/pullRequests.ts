import type { Octokit } from 'octokit';

import { parsePersistedReviewState } from '../review/format.js';
import type { PullRequestDetails, PullRequestFile } from '../types/github.js';
import type { InlineReviewComment, PersistedReviewState } from '../types/review.js';

export async function getPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestDetails> {
  const response = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  const pullRequest = response.data;

  return {
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body,
    html_url: pullRequest.html_url,
    draft: Boolean(pullRequest.draft),
    state: pullRequest.state,
    base: {
      ref: pullRequest.base.ref,
      sha: pullRequest.base.sha,
    },
    head: {
      ref: pullRequest.head.ref,
      sha: pullRequest.head.sha,
      repo: pullRequest.head.repo ? { full_name: pullRequest.head.repo.full_name } : null,
    },
    user: {
      login: pullRequest.user?.login ?? 'unknown',
      type: pullRequest.user?.type,
    },
  };
}

export async function listPullRequestFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestFile[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  return files.map((file) => {
    const normalized: PullRequestFile = {
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    };

    if (file.patch) {
      normalized.patch = file.patch;
    }

    return normalized;
  });
}

export async function hasReviewMarker(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  marker: string,
): Promise<boolean> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  return reviews.some((review) => typeof review.body === 'string' && review.body.includes(marker));
}

export async function findLatestPersistedReviewState(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PersistedReviewState | undefined> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  return reviews
    .slice()
    .sort((left, right) => {
      const leftTime = left.submitted_at ? Date.parse(left.submitted_at) : 0;
      const rightTime = right.submitted_at ? Date.parse(right.submitted_at) : 0;
      return rightTime - leftTime;
    })
    .map((review) => parsePersistedReviewState(review.body))
    .find((state): state is PersistedReviewState => Boolean(state));
}

export async function compareCommitFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<{ status: string; files: PullRequestFile[] }> {
  const response = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${baseSha}...${headSha}`,
  });

  return {
    status: response.data.status,
    files: (response.data.files ?? []).map((file) => {
      const normalized: PullRequestFile = {
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      };

      if (file.patch) {
        normalized.patch = file.patch;
      }

      return normalized;
    }),
  };
}

export async function createPullRequestReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  commitSha: string,
  body: string,
  comments: InlineReviewComment[],
): Promise<void> {
  const params = {
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: commitSha,
    event: 'COMMENT' as const,
    body,
    comments: comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: comment.body,
    })),
  };

  try {
    await octokit.rest.pulls.createReview(params);
  } catch (error) {
    if (comments.length === 0) {
      throw error;
    }

    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitSha,
      event: 'COMMENT',
      body: `${body}\n\n_Inline comments were omitted because GitHub could not anchor them to the current diff._`,
    });
  }
}

export async function createIssueComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}
