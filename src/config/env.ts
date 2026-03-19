const DEFAULT_IGNORE_PATTERNS = [
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lockb',
  '**/*.min.js',
  '**/*.map',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/node_modules/**',
];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseNumber(name: string, fallback: number): number {
  const value = optional(name);
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return parsed;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const value = optional(name);
  if (!value) {
    return fallback;
  }

  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) {
    return false;
  }

  throw new Error(`Environment variable ${name} must be a boolean`);
}

function parseCsv(value: string | undefined, fallback: string[] = []): string[] {
  if (!value) {
    return fallback;
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function decodeBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function normalizePrivateKey(): string {
  const raw = optional('GITHUB_PRIVATE_KEY');
  if (raw) {
    return raw.replace(/\\n/g, '\n');
  }

  const rawBase64 = optional('GITHUB_PRIVATE_KEY_BASE64');
  if (rawBase64) {
    return decodeBase64(rawBase64);
  }

  throw new Error('Missing required environment variable: GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_BASE64');
}

export const env = {
  port: parseNumber('PORT', 3000),
  github: {
    appId: required('GITHUB_APP_ID'),
    privateKey: normalizePrivateKey(),
    webhookSecret: required('GITHUB_WEBHOOK_SECRET'),
    botHandle: optional('GITHUB_BOT_HANDLE'),
    allowedBaseBranches: parseCsv(optional('GITHUB_ALLOWED_BASE_BRANCHES'), ['main']),
    allowedRepos: parseCsv(optional('GITHUB_ALLOWED_REPOS')),
    allowedInteractors: parseCsv(optional('GITHUB_ALLOWED_INTERACTORS')).map((login) => login.toLowerCase()),
    allowedAuthorAssociations: parseCsv(
      optional('GITHUB_ALLOWED_AUTHOR_ASSOCIATIONS'),
      ['OWNER', 'MEMBER', 'COLLABORATOR'],
    ).map((association) => association.toUpperCase()),
  },
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    baseUrl: optional('OPENAI_BASE_URL'),
    organization: optional('OPENAI_ORGANIZATION'),
    project: optional('OPENAI_PROJECT'),
    model: optional('OPENAI_MODEL') ?? 'gpt-5-mini',
    maxOutputTokens: parseNumber('OPENAI_MAX_OUTPUT_TOKENS', 4000),
    timeoutMs: parseNumber('OPENAI_TIMEOUT_MS', 120000),
    maxRetries: parseNumber('OPENAI_MAX_RETRIES', 2),
    forceStream: parseBoolean('OPENAI_FORCE_STREAM', false),
  },
  review: {
    maxFiles: parseNumber('REVIEW_MAX_FILES', 40),
    maxPatchChars: parseNumber('REVIEW_MAX_PATCH_CHARS', 120000),
    maxInlineComments: parseNumber('REVIEW_MAX_INLINE_COMMENTS', 6),
    minConfidence: parseNumber('REVIEW_MIN_CONFIDENCE', 0.72),
    summaryOnly: parseBoolean('REVIEW_SUMMARY_ONLY', false),
    commentOnClean: parseBoolean('REVIEW_COMMENT_ON_CLEAN', true),
    ignoreDrafts: parseBoolean('REVIEW_IGNORE_DRAFTS', true),
    ignorePatterns: parseCsv(optional('REVIEW_IGNORE_PATTERNS'), DEFAULT_IGNORE_PATTERNS),
  },
};
