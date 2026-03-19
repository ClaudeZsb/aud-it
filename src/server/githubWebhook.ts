import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  handleIssueCommentEvent,
  handlePullRequestReviewCommentEvent,
} from '../commands/issueComments.js';
import { env } from '../config/env.js';
import { reviewPullRequestEvent } from '../review/runner.js';
import type {
  IssueCommentWebhookPayload,
  PullRequestReviewCommentWebhookPayload,
  PullRequestWebhookPayload,
} from '../types/github.js';

function verifyGitHubSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) {
    return false;
  }

  const expected = `sha256=${createHmac('sha256', env.github.webhookSecret).update(rawBody).digest('hex')}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signatureHeader);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export async function handleGitHubWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<{
  accepted: boolean;
  statusCode: number;
  message: string;
}> {
  const signature = headers['x-hub-signature-256'];
  if (!verifyGitHubSignature(rawBody, signature)) {
    return {
      accepted: false,
      statusCode: 401,
      message: 'Invalid GitHub webhook signature',
    };
  }

  const eventName = headers['x-github-event'];
  if (!eventName) {
    return {
      accepted: false,
      statusCode: 400,
      message: 'Missing x-github-event header',
    };
  }

  if (eventName === 'ping') {
    return {
      accepted: false,
      statusCode: 200,
      message: 'pong',
    };
  }

  if (eventName === 'pull_request') {
    const payload = JSON.parse(rawBody) as PullRequestWebhookPayload;
    void reviewPullRequestEvent(payload).catch((error) => {
      console.error('pull request review failed');
      console.error(error);
    });

    return {
      accepted: true,
      statusCode: 202,
      message: 'Review queued',
    };
  }

  if (eventName === 'issue_comment') {
    const payload = JSON.parse(rawBody) as IssueCommentWebhookPayload;
    void handleIssueCommentEvent(payload).catch((error) => {
      console.error('issue comment interaction failed');
      console.error(error);
    });

    return {
      accepted: true,
      statusCode: 202,
      message: 'Comment interaction queued',
    };
  }

  if (eventName === 'pull_request_review_comment') {
    const payload = JSON.parse(rawBody) as PullRequestReviewCommentWebhookPayload;
    void handlePullRequestReviewCommentEvent(payload).catch((error) => {
      console.error('pull request review comment interaction failed');
      console.error(error);
    });

    return {
      accepted: true,
      statusCode: 202,
      message: 'Review thread interaction queued',
    };
  }

  return {
    accepted: false,
    statusCode: 200,
    message: `Ignored event: ${eventName}`,
  };
}
