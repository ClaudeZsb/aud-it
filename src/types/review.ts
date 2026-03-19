export type ReviewSeverity = 'high' | 'medium' | 'low';
export type ReviewVerdict = 'clean' | 'needs-attention' | 'skipped';
export type ReviewMode = 'full' | 'incremental';

export interface ReviewInputFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  patchTruncated: boolean;
  commentableLines: number[];
}

export interface ReviewFinding {
  title: string;
  body: string;
  path: string;
  line: number;
  severity: ReviewSeverity;
  confidence: number;
}

export interface ReviewSummary {
  overview: string;
  verdict: ReviewVerdict;
  risks: string[];
  tests: string[];
}

export interface ReviewResult {
  summary: ReviewSummary;
  findings: ReviewFinding[];
}

export interface PersistedReviewState {
  version: 1;
  reviewedHeadSha: string;
  reviewedAt: string;
  reviewMode: ReviewMode;
  baseBranch: string;
  summary: ReviewSummary;
  findings: ReviewFinding[];
}

export interface PreviousReviewContext {
  state: PersistedReviewState;
  fallbackReason?: string;
}

export interface ReviewRunContext {
  reviewMode: ReviewMode;
  previousReview?: PreviousReviewContext;
}

export interface FilteredFileSet {
  included: import('./github.js').PullRequestFile[];
  ignored: import('./github.js').PullRequestFile[];
  unsupported: import('./github.js').PullRequestFile[];
  truncatedCount: number;
}

export interface InlineReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}
