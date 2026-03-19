import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from 'octokit';

import { env } from '../config/env.js';

export function getInstallationOctokit(installationId: number): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.github.appId,
      privateKey: env.github.privateKey,
      installationId,
    },
  });
}
