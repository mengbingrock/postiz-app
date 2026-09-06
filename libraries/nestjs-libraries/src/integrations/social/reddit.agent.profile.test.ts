import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { redditAgentProfileRoot } from './reddit.agent.profile';

test('uses the shared Postiz config root instead of the process working directory', () => {
  const environment = { POSTIZ_CONFIG_DIR: '/srv/postiz/config' };

  assert.equal(
    redditAgentProfileRoot(environment, '/unused/home'),
    resolve('/srv/postiz/config/reddit-agent/profiles')
  );
});

test('uses a stable per-user default when no profile path is configured', () => {
  assert.equal(
    redditAgentProfileRoot({}, '/home/postiz'),
    resolve('/home/postiz/.postiz/reddit-agent/profiles')
  );
});

test('an explicit Reddit profile root takes precedence', () => {
  assert.equal(
    redditAgentProfileRoot(
      {
        POSTIZ_CONFIG_DIR: '/srv/postiz/config',
        REDDIT_AGENT_PROFILE_DIR: '/var/lib/postiz/reddit-profiles',
      },
      '/unused/home'
    ),
    resolve('/var/lib/postiz/reddit-profiles')
  );
});
