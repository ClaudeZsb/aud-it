import 'dotenv/config';

import { env } from './config/env.js';
import { createServer } from './server/createServer.js';

async function main() {
  const app = await createServer();
  await app.listen({ host: '0.0.0.0', port: env.port });
  app.log.info({ port: env.port }, 'audit-bot is listening');
}

main().catch((error) => {
  console.error('audit-bot failed to start');
  console.error(error);
  process.exit(1);
});
