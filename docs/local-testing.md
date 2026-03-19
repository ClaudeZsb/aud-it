# Local Testing

## What this validates

- Webhook signature verification
- Fastify endpoint wiring
- Pull request event filtering
- GitHub App authentication and PR file fetch
- OpenAI review call
- GitHub review write-back

## Required secrets

Set these in `.env` before running the bot:

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY` or `GITHUB_PRIVATE_KEY_BASE64`
- `GITHUB_WEBHOOK_SECRET`
- `OPENAI_API_KEY`

Optional but recommended:

- `GITHUB_ALLOWED_REPOS=owner/repo`
- `GITHUB_ALLOWED_BASE_BRANCHES=main`
- `GITHUB_BOT_HANDLE=aud-it`
- `GITHUB_ALLOWED_INTERACTORS=your-login`
- `GITHUB_ALLOWED_AUTHOR_ASSOCIATIONS=OWNER,MEMBER,COLLABORATOR`

If your key is for an OpenAI-compatible provider, also set:

- `OPENAI_BASE_URL`
- optionally `OPENAI_ORGANIZATION`
- optionally `OPENAI_PROJECT`
- optionally `OPENAI_FORCE_STREAM=true`

## GitHub App setup

Create a GitHub App with:

- Repository permissions:
  - `Contents: Read-only`
  - `Issues: Read and write`
  - `Pull requests: Read and write`
  - `Metadata: Read-only`
- Subscribe to:
  - `Pull request`
  - `Issue comment`
  - `Pull request review comment`
- Webhook URL:
  - local dev tunnel URL + `/webhooks/github`
- Webhook secret:
  - same value as `GITHUB_WEBHOOK_SECRET`

Install the app on the repo you want to test.

## Local run

```bash
cd /Users/user/mantle/audit-bot
cp .env.example .env
npm install
npm run dev
```

Expected local health check:

```bash
curl http://127.0.0.1:3000/healthz
```

## Tunnel the local server

Use either:

```bash
ngrok http 3000
```

or

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

Then paste the public URL into the GitHub App webhook config:

- `https://<public-url>/webhooks/github`

## End-to-end validation

1. Install the GitHub App on a test repo.
2. Open a PR targeting `main`.
3. Confirm the webhook delivery returns HTTP `202`.
4. Watch local logs for:
   - event accepted
   - PR files fetched
   - OpenAI review completed
   - GitHub review created
5. Confirm the PR receives:
   - one review summary
   - zero or more inline comments
6. Add a PR conversation comment such as:
   - `@aud-it help`
   - `@aud-it summary`
   - `@aud-it what is the riskiest part of this PR?`
7. Add an inline review-thread comment such as:
   - `@aud-it review`
   - `@aud-it can this change break batch submission?`
8. Follow up in the same PR conversation or review thread and confirm the bot answer reflects the previous exchange context.

## Replay a webhook locally

For HTTP/signature validation only:

```bash
GITHUB_WEBHOOK_SECRET=replace-me npm run send:webhook
```

For a true end-to-end replay, replace `fixtures/pull_request.opened.sample.json` with a real GitHub webhook payload from the GitHub App delivery log.

## Current review mode

The bot is currently in `incremental review` mode:

- each new head SHA is reviewed once
- the bot stores hidden review state in its GitHub review body
- if the current head is a linear descendant of the last reviewed head, it reviews only the new diff
- if history was rewritten or compare fails, it falls back to a full PR diff review

So the effective behavior is `stateful incremental review with full-review fallback`.

## Troubleshooting

- `401 Invalid GitHub webhook signature`
  - local webhook secret does not match the GitHub App webhook secret
- `Missing required environment variable`
  - `.env` is incomplete
- delivery accepted but no PR comment appears
  - check app installation permissions
  - check `GITHUB_BOT_HANDLE` matches the bot mention used in GitHub
  - check the commenter is allowed by `GITHUB_ALLOWED_INTERACTORS` or `GITHUB_ALLOWED_AUTHOR_ASSOCIATIONS`
  - check allowed repo / allowed base branch filters
  - check local logs for GitHub API or OpenAI API errors
