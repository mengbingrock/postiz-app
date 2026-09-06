import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';

export type RedNoteLoginState =
  | 'waiting_for_scan'
  | 'qr_scanned'
  | 'otp_required'
  | 'submitting_otp'
  | 'otp_submitted'
  | 'captcha_required'
  | 'authenticated'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type RedNoteLoginAgentObservation = {
  loginState: RedNoteLoginState;
  hasQrCode: boolean;
  otpAttempts: number;
  otpMaxAttempts: number;
  lastError?: string;
};

const RedNoteLoginAgentDecisionSchema = z.object({
  view: z.enum(['qr', 'waiting', 'otp', 'manual', 'complete', 'error']),
  tone: z.enum(['neutral', 'warning', 'success', 'danger']),
  title: z.string().min(1).max(80),
  message: z.string().min(1).max(280),
  primaryAction: z.enum(['none', 'submit_otp', 'restart', 'connect']),
});

type ModelDecision = z.infer<typeof RedNoteLoginAgentDecisionSchema>;

export type RedNoteLoginAgentUi = ModelDecision & {
  source: 'agent' | 'fallback';
  authMode: 'api_key' | 'chatgpt_subscription' | 'fallback';
};

const fallbackByState: Record<
  RedNoteLoginState,
  Omit<RedNoteLoginAgentUi, 'source' | 'authMode'>
> = {
  waiting_for_scan: {
    view: 'qr',
    tone: 'neutral',
    title: 'Scan the Xiaohongshu QR code',
    message:
      'Use the Xiaohongshu mobile app to scan this code and approve the login.',
    primaryAction: 'none',
  },
  qr_scanned: {
    view: 'waiting',
    tone: 'neutral',
    title: 'QR code scanned',
    message: 'Waiting for Xiaohongshu to confirm the login in Chromium.',
    primaryAction: 'none',
  },
  otp_required: {
    view: 'otp',
    tone: 'warning',
    title: 'Enter the verification code',
    message:
      'Enter the six-digit code from Xiaohongshu. Postiz submits it directly to the retained Chromium page.',
    primaryAction: 'submit_otp',
  },
  submitting_otp: {
    view: 'otp',
    tone: 'neutral',
    title: 'Submitting verification code',
    message: 'The code is being submitted to the retained Chromium page.',
    primaryAction: 'none',
  },
  otp_submitted: {
    view: 'waiting',
    tone: 'neutral',
    title: 'Verification code submitted',
    message: 'Waiting for Xiaohongshu to finish the login.',
    primaryAction: 'none',
  },
  captcha_required: {
    view: 'manual',
    tone: 'warning',
    title: 'Additional verification required',
    message:
      'Complete the verification shown below, then leave this window open while Postiz checks the same Chromium session.',
    primaryAction: 'none',
  },
  authenticated: {
    view: 'complete',
    tone: 'success',
    title: 'Xiaohongshu login complete',
    message: 'The cookie was saved. Start MCP to add this channel to Postiz.',
    primaryAction: 'connect',
  },
  failed: {
    view: 'error',
    tone: 'danger',
    title: 'Login failed',
    message: 'Start a new login session and try again.',
    primaryAction: 'restart',
  },
  expired: {
    view: 'error',
    tone: 'danger',
    title: 'QR code expired',
    message: 'Request a new QR code and scan it again.',
    primaryAction: 'restart',
  },
  cancelled: {
    view: 'error',
    tone: 'danger',
    title: 'Login session replaced',
    message: 'Start a new login session to continue.',
    primaryAction: 'restart',
  },
};

const allowedDecisionByState: Record<
  RedNoteLoginState,
  Pick<ModelDecision, 'view' | 'primaryAction' | 'tone'>
> = {
  waiting_for_scan: { view: 'qr', primaryAction: 'none', tone: 'neutral' },
  qr_scanned: { view: 'waiting', primaryAction: 'none', tone: 'neutral' },
  otp_required: {
    view: 'otp',
    primaryAction: 'submit_otp',
    tone: 'warning',
  },
  submitting_otp: { view: 'otp', primaryAction: 'none', tone: 'neutral' },
  otp_submitted: {
    view: 'waiting',
    primaryAction: 'none',
    tone: 'neutral',
  },
  captcha_required: {
    view: 'manual',
    primaryAction: 'none',
    tone: 'warning',
  },
  authenticated: {
    view: 'complete',
    primaryAction: 'connect',
    tone: 'success',
  },
  failed: { view: 'error', primaryAction: 'restart', tone: 'danger' },
  expired: { view: 'error', primaryAction: 'restart', tone: 'danger' },
  cancelled: { view: 'error', primaryAction: 'restart', tone: 'danger' },
};

export const fallbackRedNoteLoginAgentUi = (
  observation: RedNoteLoginAgentObservation
): RedNoteLoginAgentUi => {
  const fallback = fallbackByState[observation.loginState];
  if (observation.loginState === 'captcha_required' && observation.hasQrCode) {
    return {
      ...fallback,
      view: 'qr',
      title: 'Scan the account-security QR code',
      message:
        'Use the Xiaohongshu account already signed in on your phone to scan this second verification code.',
      source: 'fallback',
      authMode: 'fallback',
    };
  }
  if (observation.loginState === 'failed' && observation.lastError) {
    return {
      ...fallback,
      message: observation.lastError.slice(0, 280),
      source: 'fallback',
      authMode: 'fallback',
    };
  }
  return { ...fallback, source: 'fallback', authMode: 'fallback' };
};

export const constrainRedNoteLoginAgentUi = (
  observation: RedNoteLoginAgentObservation,
  decision: ModelDecision,
  authMode: 'api_key' | 'chatgpt_subscription' = 'api_key'
): RedNoteLoginAgentUi => {
  const allowed = allowedDecisionByState[observation.loginState];
  const fallback = fallbackRedNoteLoginAgentUi(observation);
  const expectedView =
    observation.loginState === 'captcha_required' && observation.hasQrCode
      ? 'qr'
      : allowed.view;

  if (
    decision.view !== expectedView ||
    decision.primaryAction !== allowed.primaryAction ||
    decision.tone !== allowed.tone
  ) {
    return fallback;
  }

  return { ...decision, source: 'agent', authMode };
};

const sanitizedError = (value?: string) =>
  value
    ?.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email redacted]')
    .replace(/\b\d{6,}\b/g, '[number redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[token redacted]')
    .slice(0, 500);

const CODEX_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['view', 'tone', 'title', 'message', 'primaryAction'],
  properties: {
    view: {
      type: 'string',
      enum: ['qr', 'waiting', 'otp', 'manual', 'complete', 'error'],
    },
    tone: {
      type: 'string',
      enum: ['neutral', 'warning', 'success', 'danger'],
    },
    title: { type: 'string', minLength: 1, maxLength: 80 },
    message: { type: 'string', minLength: 1, maxLength: 280 },
    primaryAction: {
      type: 'string',
      enum: ['none', 'submit_otp', 'restart', 'connect'],
    },
  },
} as const;

const resolveCodexBinary = () => {
  const configured = process.env.CODEX_CLI_BINARY?.trim();
  if (configured && isAbsolute(configured)) {
    try {
      accessSync(configured, constants.X_OK);
      return configured;
    } catch {
      return undefined;
    }
  }

  const names =
    process.platform === 'win32'
      ? [configured || 'codex.exe', 'codex.cmd', 'codex']
      : [configured || 'codex'];
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking through PATH without invoking a shell.
      }
    }
  }
  return undefined;
};

const LOGIN_AGENT_INSTRUCTIONS = `You are the login UI agent for one retained Xiaohongshu Chromium session.
Choose the clearest approved Add Channel view for the current browser observation.
Use this required mapping: waiting_for_scan=qr/neutral/none; qr_scanned=waiting/neutral/none; otp_required=otp/warning/submit_otp; submitting_otp=otp/neutral/none; otp_submitted=waiting/neutral/none; captcha_required=qr/warning/none when hasQrCode, otherwise manual/warning/none; authenticated=complete/success/connect; failed, expired, or cancelled=error/danger/restart.
Never ask for a password, cookie, recovery code, or any value other than a six-digit OTP when the state explicitly says otp_required.
Never claim login succeeded unless the state is authenticated.
Do not use tools, inspect files, or run shell commands.
Do not include HTML or Markdown. Keep the title and message concise.`;

const runCodexDecision = async (
  binary: string,
  observation: RedNoteLoginAgentObservation,
  signal?: AbortSignal
) => {
  const directory = await mkdtemp(join(tmpdir(), 'postiz-login-agent-'));
  const schemaPath = join(directory, 'schema.json');
  const outputPath = join(directory, 'decision.json');
  try {
    await writeFile(schemaPath, JSON.stringify(CODEX_OUTPUT_SCHEMA), {
      mode: 0o600,
    });
    const prompt = `${LOGIN_AGENT_INSTRUCTIONS}\n\nBrowser observation:\n${JSON.stringify(
      {
        ...observation,
        lastError: sanitizedError(observation.lastError),
      }
    )}`;

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        binary,
        [
          'exec',
          '--sandbox',
          'read-only',
          '--ephemeral',
          '--ignore-user-config',
          '--ignore-rules',
          '--skip-git-repo-check',
          '--color',
          'never',
          '--cd',
          directory,
          '--output-schema',
          schemaPath,
          '--output-last-message',
          outputPath,
          '-',
        ],
        { stdio: ['pipe', 'ignore', 'ignore'] }
      );
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const abort = () => {
        child.kill();
        finish(new Error('Codex login-agent decision was cancelled.'));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error('Codex login-agent decision timed out.'));
      }, 60_000);
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', (error) => finish(error));
      child.once('close', (code) =>
        code === 0
          ? finish()
          : finish(new Error('Codex login-agent decision failed.'))
      );
      if (signal?.aborted) {
        abort();
        return;
      }
      child.stdin.end(prompt);
    });

    return RedNoteLoginAgentDecisionSchema.parse(
      JSON.parse(await readFile(outputPath, 'utf8'))
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export class RedNoteLoginAgent {
  private readonly client?: OpenAI;
  private readonly model: string;
  private readonly codexBinary?: string;

  constructor() {
    const key = process.env.OPENAI_API_KEY?.trim();
    const enabled = process.env.REDNOTE_LOGIN_AGENT_ENABLED !== 'false';
    if (enabled && key && key.length > 20 && key !== 'sk-proj-') {
      this.client = new OpenAI({ apiKey: key });
    }
    if (
      enabled &&
      !this.client &&
      process.env.REDNOTE_LOGIN_AGENT_USE_CODEX !== 'false'
    ) {
      this.codexBinary = resolveCodexBinary();
    }
    this.model = process.env.REDNOTE_LOGIN_AGENT_MODEL || 'gpt-4.1-mini';
  }

  isEnabled() {
    return Boolean(this.client || this.codexBinary);
  }

  async decide(
    observation: RedNoteLoginAgentObservation,
    signal?: AbortSignal
  ): Promise<RedNoteLoginAgentUi> {
    if (!this.client) {
      if (this.codexBinary) {
        try {
          const decision = await runCodexDecision(
            this.codexBinary,
            observation,
            signal
          );
          return constrainRedNoteLoginAgentUi(
            observation,
            decision,
            'chatgpt_subscription'
          );
        } catch {
          return fallbackRedNoteLoginAgentUi(observation);
        }
      }
      return fallbackRedNoteLoginAgentUi(observation);
    }

    try {
      const response = await this.client.responses.parse(
        {
          model: this.model,
          store: false,
          max_output_tokens: 220,
          instructions: LOGIN_AGENT_INSTRUCTIONS,
          input: JSON.stringify({
            ...observation,
            lastError: sanitizedError(observation.lastError),
          }),
          text: {
            format: zodTextFormat(
              RedNoteLoginAgentDecisionSchema,
              'rednote_login_ui'
            ),
          },
        },
        { timeout: 8_000, maxRetries: 0, signal }
      );
      if (!response.output_parsed) {
        return fallbackRedNoteLoginAgentUi(observation);
      }
      return constrainRedNoteLoginAgentUi(observation, response.output_parsed);
    } catch {
      return fallbackRedNoteLoginAgentUi(observation);
    }
  }
}
