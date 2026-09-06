import assert from 'node:assert/strict';
import test from 'node:test';
import {
  constrainRedditAgentLoginUi,
  fallbackRedditAgentLoginUi,
} from './reddit.agent.login';

test('fallback requests only a six-digit authenticator code for Reddit 2FA', () => {
  const ui = fallbackRedditAgentLoginUi({
    loginState: 'two_factor_required',
    browserName: 'Google Chrome',
  });

  assert.equal(ui.view, 'otp');
  assert.equal(ui.primaryAction, 'submit_otp');
  assert.match(ui.message, /six-digit/i);
});

test('agent output cannot mark a credential submission as authenticated', () => {
  const observation = {
    loginState: 'submitting_credentials' as const,
    browserName: 'Chromium',
  };
  const ui = constrainRedditAgentLoginUi(observation, {
    view: 'complete',
    tone: 'success',
    title: 'Done',
    message: 'Connected',
    primaryAction: 'connect',
  });

  assert.equal(ui.source, 'fallback');
  assert.equal(ui.view, 'progress');
  assert.equal(ui.primaryAction, 'none');
});

test('valid Codex output is identified as ChatGPT subscription auth', () => {
  const observation = {
    loginState: 'authenticated' as const,
    browserName: 'Google Chrome',
  };
  const ui = constrainRedditAgentLoginUi(
    observation,
    {
      view: 'complete',
      tone: 'success',
      title: 'Reddit is ready',
      message: 'The saved browser profile can now publish.',
      primaryAction: 'connect',
    },
    'chatgpt_subscription'
  );

  assert.equal(ui.source, 'agent');
  assert.equal(ui.authMode, 'chatgpt_subscription');
});

test('external login is always handed off to the retained browser', () => {
  const ui = fallbackRedditAgentLoginUi({
    loginState: 'external_login_in_progress',
    loginMethod: 'apple',
    browserName: 'Google Chrome',
  });

  assert.equal(ui.view, 'manual');
  assert.equal(ui.primaryAction, 'none');
  assert.match(ui.message, /Apple/i);
  assert.match(ui.message, /does not receive/i);
});
