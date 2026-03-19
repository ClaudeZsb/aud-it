import { minimatch } from 'minimatch';

import type { PullRequestFile } from '../types/github.js';
import type { FilteredFileSet } from '../types/review.js';

function isIgnoredPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true, nocase: true }));
}

function isUnsupportedFile(file: PullRequestFile): boolean {
  return !file.patch || file.status === 'removed';
}

export function filterReviewableFiles(
  files: PullRequestFile[],
  ignorePatterns: string[],
  maxFiles: number,
): FilteredFileSet {
  const ignored: PullRequestFile[] = [];
  const unsupported: PullRequestFile[] = [];
  const included: PullRequestFile[] = [];

  for (const file of files) {
    if (isIgnoredPath(file.filename, ignorePatterns)) {
      ignored.push(file);
      continue;
    }

    if (isUnsupportedFile(file)) {
      unsupported.push(file);
      continue;
    }

    included.push(file);
  }

  return {
    included: included.slice(0, maxFiles),
    ignored,
    unsupported,
    truncatedCount: Math.max(0, included.length - maxFiles),
  };
}
