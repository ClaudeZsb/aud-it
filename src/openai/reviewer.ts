import OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';

import { env } from '../config/env.js';
import type { PullRequestWebhookPayload } from '../types/github.js';
import type { ReviewInputFile, ReviewResult, ReviewRunContext } from '../types/review.js';
import {
  buildQuestionInput,
  buildQuestionInstructions,
  buildReviewInput,
  buildReviewInstructions,
} from '../review/prompt.js';
import { parseReviewResult, reviewResultJsonSchema } from '../review/schema.js';

const client = new OpenAI({
  apiKey: env.openai.apiKey,
  baseURL: env.openai.baseUrl,
  organization: env.openai.organization,
  project: env.openai.project,
  timeout: env.openai.timeoutMs,
  maxRetries: env.openai.maxRetries,
});

function buildReviewResponseRequest(
  payload: PullRequestWebhookPayload,
  files: ReviewInputFile[],
  context: ReviewRunContext,
): ResponseCreateParamsNonStreaming {
  return {
    model: env.openai.model,
    instructions: buildReviewInstructions(env.review.minConfidence),
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        text: buildReviewInput(payload, files, context),
      }],
    }],
    max_output_tokens: env.openai.maxOutputTokens,
    text: {
      format: {
        type: 'json_schema',
        name: 'pull_request_audit_review',
        strict: true,
        schema: reviewResultJsonSchema,
      },
    },
  };
}

function buildQuestionResponseRequest(
  payload: PullRequestWebhookPayload,
  files: ReviewInputFile[],
  context: ReviewRunContext,
  question: string,
): ResponseCreateParamsNonStreaming {
  return {
    model: env.openai.model,
    instructions: buildQuestionInstructions(),
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        text: buildQuestionInput(payload, files, context, question),
      }],
    }],
    max_output_tokens: env.openai.maxOutputTokens,
  };
}

function shouldRetryAsStream(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeError = error as { status?: number; error?: { message?: string } };
  const message = maybeError.error?.message?.toLowerCase() ?? '';
  return maybeError.status === 400 && message.includes('stream must be set to true');
}

function buildStreamingParams(params: ResponseCreateParamsNonStreaming) {
  return {
    ...params,
    stream: true as const,
  };
}

function extractResponseText(response: {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}): string {
  if (typeof response.output_text === 'string' && response.output_text.length > 0) {
    return response.output_text;
  }

  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message') {
      continue;
    }

    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join('');
}

export async function reviewPullRequestWithAI(
  payload: PullRequestWebhookPayload,
  files: ReviewInputFile[],
  context: ReviewRunContext,
): Promise<ReviewResult> {
  const params = buildReviewResponseRequest(payload, files, context);

  return parseReviewResult(await createResponseText(params));
}

async function createResponseText(params: ResponseCreateParamsNonStreaming): Promise<string> {
  if (env.openai.forceStream) {
    const stream = client.responses.stream(buildStreamingParams(params));
    const response = await stream.finalResponse();
    return extractResponseText(response);
  }

  try {
    const response = await client.responses.create(params);
    return extractResponseText(response);
  } catch (error) {
    if (!shouldRetryAsStream(error)) {
      throw error;
    }

    const stream = client.responses.stream(buildStreamingParams(params));
    const response = await stream.finalResponse();
    return extractResponseText(response);
  }
}

export async function answerPullRequestQuestion(
  payload: PullRequestWebhookPayload,
  files: ReviewInputFile[],
  context: ReviewRunContext,
  question: string,
): Promise<string> {
  const params = buildQuestionResponseRequest(payload, files, context, question);
  return createResponseText(params);
}
