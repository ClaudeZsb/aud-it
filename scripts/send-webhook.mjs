import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [, , payloadPath = 'fixtures/pull_request.opened.sample.json', endpoint = 'http://127.0.0.1:3000/webhooks/github'] = process.argv;

const secret = process.env.GITHUB_WEBHOOK_SECRET;
if (!secret) {
  console.error('Missing GITHUB_WEBHOOK_SECRET in environment');
  process.exit(1);
}

const rawBody = await readFile(payloadPath, 'utf8');
const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-github-event': 'pull_request',
    'x-hub-signature-256': signature,
  },
  body: rawBody,
});

const text = await response.text();
console.log(`status=${response.status}`);
console.log(text);
