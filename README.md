# audit-bot

A GitHub App webhook service that automatically reviews pull requests targeting `main` with OpenAI and posts a GitHub review summary plus optional inline comments.

## What it does

- Listens for pull request events from a GitHub App
- Lets approved users talk to the bot by mentioning it in the PR conversation or an inline review thread
- Ignores non-`main` PRs by default
- Fetches changed files and patches from GitHub
- Filters low-signal files like lockfiles and build output
- Sends the review context to OpenAI
- Posts a GitHub review with a summary and high-confidence inline comments
- Deduplicates by head commit SHA so the same commit is not reviewed twice

## Setup

### 1. Create a GitHub App

Recommended permissions:

- Repository permissions:
  - `Contents: Read-only`
  - `Issues: Read and write`
  - `Pull requests: Read and write`
  - `Metadata: Read-only`
- Subscribe to events:
  - `Pull request`
  - `Issue comment`
  - `Pull request review comment`

Set the webhook URL to your deployed bot endpoint:

- `https://your-bot.example.com/webhooks/github`

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in the values.

The private key can be passed either as:

- `GITHUB_PRIVATE_KEY` with `\n`-escaped newlines
- `GITHUB_PRIVATE_KEY_BASE64` with a base64-encoded PEM

Advanced OpenAI-compatible configuration is supported too:

- `OPENAI_BASE_URL`
- `OPENAI_ORGANIZATION`
- `OPENAI_PROJECT`
- `OPENAI_TIMEOUT_MS`
- `OPENAI_MAX_RETRIES`
- `OPENAI_FORCE_STREAM`

This is useful when your key is valid against an OpenAI-compatible provider instead of the default OpenAI API endpoint.

For mention-based interaction and access control, also configure:

- `GITHUB_BOT_HANDLE`
- `GITHUB_ALLOWED_INTERACTORS`
- `GITHUB_ALLOWED_AUTHOR_ASSOCIATIONS`

### 3. Install and run

```bash
npm install
npm run dev
```

For production:

```bash
npm run build
npm start
```

## Review behavior

By default the bot:

- reacts to `opened`, `synchronize`, `ready_for_review`, and `reopened`
- ignores draft PRs
- reviews only PRs whose base branch is `main`
- comments even on clean PRs so the team can see it ran
- posts inline comments only for high-confidence findings that can be anchored to added lines in the diff

## Bot Mentions

Approved users can mention the bot in the main PR conversation or inside an inline review thread:

- `@aud-it review`
- `@aud-it review force`
- `@aud-it summary`
- `@aud-it what is the riskiest part of this PR?`

Interaction is gated in two ways:

- explicit login allowlist via `GITHUB_ALLOWED_INTERACTORS`
- trusted GitHub author associations via `GITHUB_ALLOWED_AUTHOR_ASSOCIATIONS`

By default, only `OWNER`, `MEMBER`, and `COLLABORATOR` can interact.

The bot also carries the latest few exchanges from the same PR conversation or review thread into follow-up answers, so mention-based discussions can stay incremental.

Legacy `/audit ...` commands still work as a fallback, but `@aud-it ...` is now the primary interaction model.

## Deployment notes

Any always-on HTTP environment works, for example:

- Fly.io
- Railway
- Render
- ECS/Fargate
- Kubernetes

For local GitHub webhook testing, expose the bot with a tunnel like ngrok or Cloudflare Tunnel.

## Render deployment

This repo includes [render.yaml](render.yaml) for a free-tier Render web service.

Recommended Render flow:

1. Create a new Blueprint or Web Service from this repository.
2. Confirm the build command is `npm install && npm run build`.
3. Confirm the start command is `npm start`.
4. Set the secret environment variables in Render:
   - `GITHUB_APP_ID`
   - `GITHUB_PRIVATE_KEY_BASE64`
   - `GITHUB_WEBHOOK_SECRET`
   - `GITHUB_ALLOWED_REPOS`
   - `OPENAI_API_KEY`
5. After Render deploys, update the GitHub App webhook URL to:
   - `https://<your-render-domain>/webhooks/github`

## Local integration

See [docs/local-testing.md](docs/local-testing.md) for:

- GitHub App settings
- local tunnel setup
- webhook replay
- end-to-end validation steps

## Current review mode

The current implementation supports incremental review.

It does this:

- stores hidden review state on each bot review
- when a PR gets a new head SHA, compares the last reviewed SHA to the current SHA
- reviews only the newly introduced diff when the history is linear
- skips duplicate reviews for the same head SHA
- falls back to a full PR diff review after force-push or non-linear history changes

So the current behavior is best described as:

- `stateful incremental review with full-review fallback`
