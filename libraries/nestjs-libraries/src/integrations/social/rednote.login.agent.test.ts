import assert from 'node:assert/strict';
import test from 'node:test';
import {
  constrainRedNoteLoginAgentUi,
  fallbackRedNoteLoginAgentUi,
} from './rednote.login.agent';

test('fallback asks for an OTP only when Chromium reports otp_required', () => {
  const ui = fallbackRedNoteLoginAgentUi({
    loginState: 'otp_required',
    hasQrCode: false,
    otpAttempts: 1,
    otpMaxAttempts: 3,
  });

  assert.equal(ui.view, 'otp');
  assert.equal(ui.primaryAction, 'submit_otp');
});

test('fallback renders a second security QR in the existing box', () => {
  const ui = fallbackRedNoteLoginAgentUi({
    loginState: 'captcha_required',
    hasQrCode: true,
    otpAttempts: 0,
    otpMaxAttempts: 3,
  });

  assert.equal(ui.view, 'qr');
  assert.match(ui.title, /account-security QR/i);
});

test('agent output cannot turn a waiting browser into a successful connection', () => {
  const observation = {
    loginState: 'waiting_for_scan' as const,
    hasQrCode: true,
    otpAttempts: 0,
    otpMaxAttempts: 3,
  };
  const ui = constrainRedNoteLoginAgentUi(observation, {
    view: 'complete',
    tone: 'success',
    title: 'Done',
    message: 'Connected',
    primaryAction: 'connect',
  });

  assert.equal(ui.source, 'fallback');
  assert.equal(ui.authMode, 'fallback');
  assert.equal(ui.view, 'qr');
  assert.equal(ui.primaryAction, 'none');
});

test('valid Codex output is identified as ChatGPT subscription auth', () => {
  const observation = {
    loginState: 'qr_scanned' as const,
    hasQrCode: true,
    otpAttempts: 0,
    otpMaxAttempts: 3,
  };
  const ui = constrainRedNoteLoginAgentUi(
    observation,
    {
      view: 'waiting',
      tone: 'neutral',
      title: 'Approval received',
      message: 'Waiting for Xiaohongshu to finish signing in.',
      primaryAction: 'none',
    },
    'chatgpt_subscription'
  );

  assert.equal(ui.source, 'agent');
  assert.equal(ui.authMode, 'chatgpt_subscription');
});
