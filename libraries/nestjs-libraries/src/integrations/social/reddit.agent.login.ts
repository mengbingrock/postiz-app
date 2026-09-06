import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';

export type RedditAgentLoginState =
  | 'starting_browser'
  | 'submitting_credentials'
  | 'external_login_in_progress'
  | 'two_factor_required'
  | 'submitting_two_factor'
  | 'challenge_required'
  | 'authenticated'
  | 'invalid_credentials'
  | 'failed';

export type RedditAgentLoginObservation = {
  loginState: RedditAgentLoginState;
  loginMethod?:
    | 'password'
    | 'google'
    | 'apple'
    | 'phone'
    | 'email_link'
    | 'sso';
  browserName?: string;
  lastError?: string;
};

const DecisionSchema = z.object({
  view: z.enum(['progress', 'otp', 'manual', 'complete', 'error']),
  tone: z.enum(['neutral', 'warning', 'success', 'danger']),
  title: z.string().min(1).max(80),
  message: z.string().min(1).max(280),
  primaryAction: z.enum(['none', 'submit_otp', 'restart', 'connect']),
});

type Decision = z.infer<typeof DecisionSchema>;

export type RedditAgentLoginUi = Decision & {
  source: 'agent' | 'fallback';
  authMode: 'api_key' | 'chatgpt_subscription' | 'fallback';
};

const fallbackByState: Record<RedditAgentLoginState, Decision> = {
  starting_browser: {
    view: 'progress',
    tone: 'neutral',
    title: 'Starting a private browser',
    message: 'Postiz is opening the saved Reddit browser profile.',
    primaryAction: 'none',
  },
  submitting_credentials: {
    view: 'progress',
    tone: 'neutral',
    title: 'Signing in to Reddit',
    message:
      'The credentials are being submitted directly to Reddit and will not be saved by Postiz.',
    primaryAction: 'none',
  },
  external_login_in_progress: {
    view: 'manual',
    tone: 'neutral',
    title: 'Complete sign-in in the browser',
    message:
      'Finish the selected Reddit sign-in method in the opened browser. Postiz does not receive third-party credentials.',
    primaryAction: 'none',
  },
  two_factor_required: {
    view: 'otp',
    tone: 'warning',
    title: 'Enter your Reddit verification code',
    message:
      'Enter the current six-digit code from your authenticator. It will be submitted only to the retained Reddit page.',
    primaryAction: 'submit_otp',
  },
  submitting_two_factor: {
    view: 'progress',
    tone: 'neutral',
    title: 'Checking the verification code',
    message: 'Reddit is checking the code in the retained browser session.',
    primaryAction: 'none',
  },
  challenge_required: {
    view: 'manual',
    tone: 'warning',
    title: 'Reddit needs a browser check',
    message:
      'Complete the visible Reddit security challenge in the opened browser. Postiz will keep checking the same session.',
    primaryAction: 'none',
  },
  authenticated: {
    view: 'complete',
    tone: 'success',
    title: 'Reddit login complete',
    message:
      'The persistent browser profile is ready for future Postiz publishing.',
    primaryAction: 'connect',
  },
  invalid_credentials: {
    view: 'error',
    tone: 'danger',
    title: 'Reddit rejected the login',
    message: 'Check the username and password, then start a new login.',
    primaryAction: 'restart',
  },
  failed: {
    view: 'error',
    tone: 'danger',
    title: 'Reddit login failed',
    message: 'Start a new login session and try again.',
    primaryAction: 'restart',
  },
};

const allowedByState: Record<
  RedditAgentLoginState,
  Pick<Decision, 'view' | 'tone' | 'primaryAction'>
> = {
  starting_browser: {
    view: 'progress',
    tone: 'neutral',
    primaryAction: 'none',
  },
  submitting_credentials: {
    view: 'progress',
    tone: 'neutral',
    primaryAction: 'none',
  },
  external_login_in_progress: {
    view: 'manual',
    tone: 'neutral',
    primaryAction: 'none',
  },
  two_factor_required: {
    view: 'otp',
    tone: 'warning',
    primaryAction: 'submit_otp',
  },
  submitting_two_factor: {
    view: 'progress',
    tone: 'neutral',
    primaryAction: 'none',
  },
  challenge_required: {
    view: 'manual',
    tone: 'warning',
    primaryAction: 'none',
  },
  authenticated: {
    view: 'complete',
    tone: 'success',
    primaryAction: 'connect',
  },
  invalid_credentials: {
    view: 'error',
    tone: 'danger',
    primaryAction: 'restart',
  },
  failed: { view: 'error', tone: 'danger', primaryAction: 'restart' },
};

export const fallbackRedditAgentLoginUi = (
  observation: RedditAgentLoginObservation
): RedditAgentLoginUi => {
  const fallback = fallbackByState[observation.loginState];
  const methodLabel =
    observation.loginMethod === 'google'
      ? 'Google'
      : observation.loginMethod === 'apple'
      ? 'Apple'
      : observation.loginMethod === 'phone'
      ? 'phone number'
      : observation.loginMethod === 'email_link'
      ? 'email link'
      : observation.loginMethod === 'sso'
      ? 'SSO'
      : 'selected';
  return {
    ...fallback,
    ...(observation.loginState === 'external_login_in_progress'
      ? {
          title: `Complete ${methodLabel} sign-in`,
          message: `Finish signing in with ${methodLabel} in the opened browser. Postiz does not receive those credentials.`,
        }
      : {}),
    ...(observation.loginState === 'failed' && observation.lastError
      ? { message: observation.lastError.slice(0, 280) }
      : {}),
    source: 'fallback',
    authMode: 'fallback',
  };
};

export const constrainRedditAgentLoginUi = (
  observation: RedditAgentLoginObservation,
  decision: Decision,
  authMode: 'api_key' | 'chatgpt_subscription' = 'api_key'
): RedditAgentLoginUi => {
  const allowed = allowedByState[observation.loginState];
  if (
    decision.view !== allowed.view ||
    decision.tone !== allowed.tone ||
    decision.primaryAction !== allowed.primaryAction
  ) {
    return fallbackRedditAgentLoginUi(observation);
  }
  return { ...decision, source: 'agent', authMode };
};

const sanitizedError = (value?: string) =>
  value
    ?.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email redacted]')
    .replace(/\b\d{6,}\b/g, '[number redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[token redacted]')
    .slice(0, 500);

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['view', 'tone', 'title', 'message', 'primaryAction'],
  properties: {
    view: {
      type: 'string',
      enum: ['progress', 'otp', 'manual', 'complete', 'error'],
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
        // Continue without invoking a shell.
      }
    }
  }
  return undefined;
};

const INSTRUCTIONS = `You are the login UI agent for one retained Reddit Chromium session.
Choose the clearest approved Add Channel view for the current browser observation.
Use this required mapping: starting_browser=progress/neutral/none; submitting_credentials=progress/neutral/none; external_login_in_progress=manual/neutral/none; two_factor_required=otp/warning/submit_otp; submitting_two_factor=progress/neutral/none; challenge_required=manual/warning/none; authenticated=complete/success/connect; invalid_credentials or failed=error/danger/restart.
Never ask for a password, cookie, backup code, recovery code, or any value other than a six-digit authenticator code when the state explicitly says two_factor_required.
Never claim login succeeded unless the state is authenticated.
Do not use tools, inspect files, or run shell commands.
Do not include HTML or Markdown. Keep the title and message concise.`;

const runCodexDecision = async (
  binary: string,
  observation: RedditAgentLoginObservation,
  signal?: AbortSignal
) => {
  const directory = await mkdtemp(join(tmpdir(), 'postiz-reddit-agent-'));
  const schemaPath = join(directory, 'schema.json');
  const outputPath = join(directory, 'decision.json');
  try {
    await writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA), { mode: 0o600 });
    const prompt = `${INSTRUCTIONS}\n\nBrowser observation:\n${JSON.stringify({
      ...observation,
      lastError: sanitizedError(observation.lastError),
    })}`;

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
        finish(new Error('Codex Reddit login decision was cancelled.'));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error('Codex Reddit login decision timed out.'));
      }, 60_000);
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', (error) => finish(error));
      child.once('close', (code) =>
        code === 0
          ? finish()
          : finish(new Error('Codex Reddit login decision failed.'))
      );
      if (signal?.aborted) {
        abort();
        return;
      }
      child.stdin.end(prompt);
    });

    return DecisionSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export class RedditLoginAgent {
  private readonly client?: OpenAI;
  private readonly model: string;
  private readonly codexBinary?: string;

  constructor() {
    const key = process.env.OPENAI_API_KEY?.trim();
    const enabled = process.env.REDDIT_LOGIN_AGENT_ENABLED !== 'false';
    if (enabled && key && key.length > 20 && key !== 'sk-proj-') {
      this.client = new OpenAI({ apiKey: key });
    }
    if (
      enabled &&
      !this.client &&
      process.env.REDDIT_LOGIN_AGENT_USE_CODEX !== 'false'
    ) {
      this.codexBinary = resolveCodexBinary();
    }
    this.model = process.env.REDDIT_LOGIN_AGENT_MODEL || 'gpt-4.1-mini';
  }

  isEnabled() {
    return Boolean(this.client || this.codexBinary);
  }

  async decide(
    observation: RedditAgentLoginObservation,
    signal?: AbortSignal
  ): Promise<RedditAgentLoginUi> {
    if (!this.client) {
      if (this.codexBinary) {
        try {
          const decision = await runCodexDecision(
            this.codexBinary,
            observation,
            signal
          );
          return constrainRedditAgentLoginUi(
            observation,
            decision,
            'chatgpt_subscription'
          );
        } catch {
          return fallbackRedditAgentLoginUi(observation);
        }
      }
      return fallbackRedditAgentLoginUi(observation);
    }

    try {
      const response = await this.client.responses.parse(
        {
          model: this.model,
          store: false,
          max_output_tokens: 220,
          instructions: INSTRUCTIONS,
          input: JSON.stringify({
            ...observation,
            lastError: sanitizedError(observation.lastError),
          }),
          text: {
            format: zodTextFormat(DecisionSchema, 'reddit_login_ui'),
          },
        },
        { timeout: 8_000, maxRetries: 0, signal }
      );
      if (!response.output_parsed) {
        return fallbackRedditAgentLoginUi(observation);
      }
      return constrainRedditAgentLoginUi(observation, response.output_parsed);
    } catch {
      return fallbackRedditAgentLoginUi(observation);
    }
  }
}
