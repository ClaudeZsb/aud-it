import type { PullRequestFile } from '../types/github.js';
import type { ReviewInputFile } from '../types/review.js';

export function extractAddedLinesFromPatch(patch: string): number[] {
  const addedLines = new Set<number>();
  const lines = patch.split('\n');

  let currentNewLine = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match) {
        continue;
      }

      currentNewLine = Number(match[1]);
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines.add(currentNewLine);
      currentNewLine += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      continue;
    }

    currentNewLine += 1;
  }

  return [...addedLines].sort((a, b) => a - b);
}

export function buildReviewInputFiles(files: PullRequestFile[], maxPatchChars: number): ReviewInputFile[] {
  const result: ReviewInputFile[] = [];
  let remainingPatchChars = maxPatchChars;

  for (const file of files) {
    if (remainingPatchChars <= 0) {
      break;
    }

    const fullPatch = file.patch ?? '';
    const patchTruncated = fullPatch.length > remainingPatchChars;
    const patch = patchTruncated ? fullPatch.slice(0, remainingPatchChars) : fullPatch;

    result.push({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch,
      patchTruncated,
      commentableLines: extractAddedLinesFromPatch(patch),
    });

    remainingPatchChars -= patch.length;
  }

  return result;
}
