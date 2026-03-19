import type { ReviewResult, ReviewSeverity, ReviewVerdict } from '../types/review.js';

const ALLOWED_SEVERITIES = new Set<ReviewSeverity>(['high', 'medium', 'low']);
const ALLOWED_VERDICTS = new Set<ReviewVerdict>(['clean', 'needs-attention', 'skipped']);

export const reviewResultJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['overview', 'verdict', 'risks', 'tests'],
      properties: {
        overview: { type: 'string' },
        verdict: { type: 'string', enum: ['clean', 'needs-attention', 'skipped'] },
        risks: {
          type: 'array',
          items: { type: 'string' },
        },
        tests: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body', 'path', 'line', 'severity', 'confidence'],
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          path: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function extractJsonObject(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    return trimmed;
  }

  const fenced = /```json\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

export function parseReviewResult(text: string): ReviewResult {
  const parsed = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  const summary = (parsed.summary ?? {}) as Record<string, unknown>;
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];

  const verdict = typeof summary.verdict === 'string' && ALLOWED_VERDICTS.has(summary.verdict as ReviewVerdict)
    ? (summary.verdict as ReviewVerdict)
    : 'clean';

  return {
    summary: {
      overview: typeof summary.overview === 'string' ? summary.overview : 'No summary provided.',
      verdict,
      risks: asStringArray(summary.risks),
      tests: asStringArray(summary.tests),
    },
    findings: rawFindings.flatMap((item) => {
      if (!item || typeof item !== 'object') {
        return [];
      }

      const finding = item as Record<string, unknown>;
      const severity = typeof finding.severity === 'string' && ALLOWED_SEVERITIES.has(finding.severity as ReviewSeverity)
        ? (finding.severity as ReviewSeverity)
        : 'low';
      const confidence = typeof finding.confidence === 'number' ? finding.confidence : 0;
      const line = typeof finding.line === 'number' ? Math.floor(finding.line) : 0;

      if (
        typeof finding.title !== 'string' ||
        typeof finding.body !== 'string' ||
        typeof finding.path !== 'string' ||
        line <= 0
      ) {
        return [];
      }

      return [{
        title: finding.title,
        body: finding.body,
        path: finding.path,
        line,
        severity,
        confidence,
      }];
    }),
  };
}
