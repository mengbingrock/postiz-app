import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

type RedditProfileEnvironment = {
  REDDIT_AGENT_PROFILE_DIR?: string;
  POSTIZ_CONFIG_DIR?: string;
};

/**
 * Resolve one process-independent Reddit profile root.
 *
 * pnpm starts the backend and orchestrator with different working directories,
 * so process.cwd() must not participate in authentication-state storage.
 */
export const redditAgentProfileRoot = (
  environment: RedditProfileEnvironment = process.env as RedditProfileEnvironment,
  userHome = homedir()
) => {
  const explicitProfileRoot = environment.REDDIT_AGENT_PROFILE_DIR?.trim();
  if (explicitProfileRoot) return resolve(explicitProfileRoot);

  const postizConfigRoot =
    environment.POSTIZ_CONFIG_DIR?.trim() || join(userHome, '.postiz');
  return resolve(postizConfigRoot, 'reddit-agent', 'profiles');
};
