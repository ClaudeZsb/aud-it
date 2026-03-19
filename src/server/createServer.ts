import Fastify from 'fastify';

import { handleGitHubWebhook } from './githubWebhook.js';

export async function createServer() {
  const app = Fastify({ logger: true });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/webhooks/github', async (request, reply) => {
    const rawPayload = typeof request.body === 'string' ? request.body : undefined;

    if (!rawPayload) {
      reply.code(400).send({ ok: false, error: 'Missing raw request body' });
      return;
    }

    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(',') : value]),
    );

    const result = await handleGitHubWebhook(headers, rawPayload);
    reply.code(result.statusCode).send({ ok: result.statusCode < 400, message: result.message, accepted: result.accepted });
  });

  return app;
}
