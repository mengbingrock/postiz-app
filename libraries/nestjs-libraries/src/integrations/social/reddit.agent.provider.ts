import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, isAbsolute, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  Browser,
  BrowserContext,
  CDPSession,
  chromium,
  Locator,
  Page,
} from 'playwright';
import { Integration } from '@prisma/client';
import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  BadBody,
  SocialAbstract,
  ValidityMedia,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { RedditSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/reddit.dto';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { Tool } from '@gitroom/nestjs-libraries/integrations/tool.decorator';
import {
  fallbackRedditAgentLoginUi,
  RedditAgentLoginObservation,
  RedditAgentLoginState,
  RedditAgentLoginUi,
  RedditLoginAgent,
} from '@gitroom/nestjs-libraries/integrations/social/reddit.agent.login';
import {
  RedNoteCredentials,
  RedNoteProvider,
} from '@gitroom/nestjs-libraries/integrations/social/rednote.provider';
import { redNoteBinaryPaths } from '@gitroom/nestjs-libraries/integrations/social/rednote.binary.installer';
import { redditAgentProfileRoot } from '@gitroom/nestjs-libraries/integrations/social/reddit.agent.profile';

type RedditAgentCredentials = RedNoteCredentials & {
  profileKey: string;
  profileName: string;
  username: string;
};

type RedditAgentLoginMethod =
  | 'password'
  | 'google'
  | 'apple'
  | 'phone'
  | 'email_link'
  | 'sso';

type InteractiveLogin = {
  status: 'idle' | 'running' | 'success' | 'error';
  message: string;
  loginState: RedditAgentLoginState;
  username?: string;
  pendingPassword?: string;
  loginMethod?: RedditAgentLoginMethod;
  pendingExternalStart?: boolean;
  profileKey?: string;
  profileName?: string;
  browserName?: string;
  connectionCode?: string;
  viewerUrl?: string;
  viewerId?: string;
  context?: BrowserContext;
  browser?: Browser;
  browserProcess?: ChildProcess;
  cdp?: CDPSession;
  liveUrlId?: string;
  frameData?: string;
  frameWidth?: number;
  frameHeight?: number;
  frameVersion?: number;
  remote?: boolean;
  remoteStopUrl?: string;
  page?: Page;
  statusCheck?: Promise<void>;
  completion?: Promise<void>;
  otpSubmission?: Promise<void>;
  agentUi?: RedditAgentLoginUi;
  agentFingerprint?: string;
  agentDecision?: Promise<void>;
  agentAbort?: AbortController;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

export type RedditAgentBrowserInput =
  | {
      kind: 'mouse';
      type: 'move' | 'down' | 'up';
      x: number;
      y: number;
      button?: 'left' | 'middle' | 'right';
    }
  | {
      kind: 'wheel';
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
    }
  | {
      kind: 'key';
      type: 'down' | 'up';
      key: string;
      code?: string;
      text?: string;
      modifiers?: number;
    }
  | { kind: 'text'; text: string };

const interactiveLogins = new Map<string, InteractiveLogin>();
const activeProfiles = new Set<string>();
const PROFILE_KEY_PATTERN = /^[a-f0-9]{32}$/;
const TWO_FACTOR_CODE_PATTERN = /^\d{6}$/;
const REDDIT_AUTH_STATE_FILE = 'reddit-auth-state.enc';
const REDDIT_BROWSER_STATE_FILE = 'reddit-browser-state.json';
const DEFAULT_MCP_ENDPOINT = 'http://127.0.0.1:18060/mcp';
const REMOTE_LOGIN_TIMEOUT_MS = 10 * 60_000;

type RedditCookieState = Awaited<ReturnType<BrowserContext['cookies']>>;

const profilePath = (profileKey: string) => {
  if (!PROFILE_KEY_PATTERN.test(profileKey)) {
    throw new Error('Invalid Reddit browser profile identifier.');
  }
  return join(redditAgentProfileRoot(), profileKey);
};

const authStatePath = (profileKey: string) =>
  join(profilePath(profileKey), REDDIT_AUTH_STATE_FILE);

const redditDomain = (domain: string) =>
  domain === 'reddit.com' || domain.endsWith('.reddit.com');

const browserlessConfig = () => {
  const token =
    process.env.REDDIT_AGENT_BROWSERLESS_TOKEN?.trim() ||
    process.env.BROWSERLESS_TOKEN?.trim();
  const configuredOrigin = process.env.REDDIT_AGENT_BROWSERLESS_URL?.trim();
  if (!token && !configuredOrigin) return undefined;
  const origin = new URL(
    configuredOrigin || 'https://production-sfo.browserless.io'
  );
  if (!['http:', 'https:'].includes(origin.protocol)) {
    throw new Error('REDDIT_AGENT_BROWSERLESS_URL must use HTTP or HTTPS.');
  }
  return { origin, token };
};

const useRemoteLogin = () => {
  const configured = process.env.REDDIT_AGENT_REMOTE_LOGIN?.trim();
  if (configured === 'false') return false;
  if (configured === 'true' && !browserlessConfig()) {
    throw new Error(
      'Remote Reddit login requires REDDIT_AGENT_BROWSERLESS_URL or REDDIT_AGENT_BROWSERLESS_TOKEN.'
    );
  }
  return Boolean(browserlessConfig());
};

const authStateKey = () => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required to protect Reddit login state.');
  }
  return createHash('sha256')
    .update(`${process.env.JWT_SECRET}\0reddit-agent-auth-state-v1`)
    .digest();
};

const encryptCookieState = (cookies: RedditCookieState) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', authStateKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(cookies), 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
};

const decryptCookieState = (payload: string): RedditCookieState => {
  const [version, encodedIv, encodedTag, encodedData] = payload
    .trim()
    .split('.');
  if (version !== 'v1' || !encodedIv || !encodedTag || !encodedData) {
    throw new Error('The saved Reddit authentication state is invalid.');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    authStateKey(),
    Buffer.from(encodedIv, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encodedData, 'base64url')),
    decipher.final(),
  ]);
  const cookies = JSON.parse(decrypted.toString('utf8')) as RedditCookieState;
  if (
    !Array.isArray(cookies) ||
    cookies.some(({ domain }) => !redditDomain(domain))
  ) {
    throw new Error('The saved Reddit authentication state is invalid.');
  }
  return cookies;
};

const firstExecutable = (paths: Array<string | undefined>) => {
  for (const path of paths) {
    if (!path || !isAbsolute(path)) continue;
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Continue to the next platform-specific browser candidate.
    }
  }
  return undefined;
};

const browserExecutable = () => {
  const configured = process.env.REDDIT_AGENT_BROWSER?.trim();
  const candidates =
    process.platform === 'darwin'
      ? [
          configured,
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          chromium.executablePath(),
        ]
      : process.platform === 'win32'
      ? [
          configured,
          process.env.PROGRAMFILES
            ? join(
                process.env.PROGRAMFILES,
                'Google',
                'Chrome',
                'Application',
                'chrome.exe'
              )
            : undefined,
          process.env['PROGRAMFILES(X86)']
            ? join(
                process.env['PROGRAMFILES(X86)'],
                'Google',
                'Chrome',
                'Application',
                'chrome.exe'
              )
            : undefined,
          chromium.executablePath(),
        ]
      : [
          configured,
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          chromium.executablePath(),
        ];
  const executablePath = firstExecutable(candidates);
  if (!executablePath) {
    throw new Error(
      'Chrome or Chromium was not found. Install Google Chrome or run `pnpm exec playwright install chromium`.'
    );
  }
  return {
    executablePath,
    browserName: basename(executablePath).toLowerCase().includes('chrom')
      ? basename(executablePath)
      : 'Chrome',
  };
};

const loginHeadless = () =>
  process.env.REDDIT_AGENT_HEADLESS
    ? process.env.REDDIT_AGENT_HEADLESS !== 'false'
    : process.env.NODE_ENV === 'production';

const availableLoopbackPort = async () => {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolvePromise) =>
    server.close(() => resolvePromise())
  );
  if (!port) throw new Error('Unable to reserve a Chrome debugging port.');
  return port;
};

const isVisible = async (locator: Locator) =>
  (await locator.count()) > 0 && (await locator.first().isVisible());

const firstVisible = async (page: Page, selectors: string[]) => {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await isVisible(locator)) return locator;
  }
  return undefined;
};

const safePageText = async (page: Page) =>
  (
    await page
      .locator('body')
      .innerText({ timeout: 5_000 })
      .catch(() => '')
  )
    .replace(/\s+/g, ' ')
    .slice(0, 12_000);

export class RedditAgentProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'reddit-agent';
  name = 'Reddit Agent';
  toolTip = 'Uses a private saved Chrome/Chromium profile instead of OAuth.';
  isBetweenSteps = false;
  scopes: string[] = [];
  editor = 'normal' as const;
  dto = RedditSettingsDto;
  override maxConcurrentJob = 1;
  private readonly redditLoginAgent = new RedditLoginAgent();
  private readonly mcpBridge = new RedNoteProvider();

  maxLength() {
    return 10_000;
  }

  override async checkValidity(
    posts: Array<ValidityMedia[]>,
    settings: RedditSettingsDto
  ): Promise<string | true> {
    if (
      settings?.subreddit?.some(
        (entry) => entry?.value?.type === 'media' && posts?.[0]?.length !== 1
      )
    ) {
      return 'A Reddit Agent media post requires exactly one file.';
    }
    return true;
  }

  async generateAuthUrl() {
    const state = makeId(6);
    return { url: state, state, codeVerifier: makeId(30) };
  }

  private encodeRedditCredentials(credentials: RedditAgentCredentials) {
    return Buffer.from(JSON.stringify(credentials), 'utf8').toString(
      'base64url'
    );
  }

  private decodeRedditCredentials(value: string): RedditAgentCredentials {
    try {
      const credentials = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8')
      ) as RedditAgentCredentials;
      if (
        !PROFILE_KEY_PATTERN.test(credentials.profileKey) ||
        !credentials.username ||
        credentials.username.length > 64 ||
        !credentials.profileName ||
        credentials.profileName.length > 80
      ) {
        throw new Error('invalid');
      }
      return {
        ...credentials,
        ...this.mcpCredentials(credentials.profileName),
      };
    } catch {
      throw new Error(
        'Invalid Reddit Agent browser profile. Reconnect the channel.'
      );
    }
  }

  private mcpCredentials(profileName: string): RedNoteCredentials {
    return {
      binaryPath: process.env.XHS_MCP_BINARY || redNoteBinaryPaths().mcpPath,
      mcpEndpoint: process.env.XHS_MCP_ENDPOINT || DEFAULT_MCP_ENDPOINT,
      profileName,
    };
  }

  private async saveRedditBrowserState(
    profileKey: string,
    cookies: RedditCookieState
  ) {
    const directory = profilePath(profileKey);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    const path = join(directory, REDDIT_BROWSER_STATE_FILE);
    await writeFile(
      path,
      `${JSON.stringify(
        {
          version: 1,
          saved_at: new Date().toISOString(),
          cookies: cookies.filter(({ domain }) => redditDomain(domain)),
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    if (process.platform !== 'win32') await chmod(path, 0o600);
  }

  private async ensureRedditBrowserState(profileKey: string) {
    const cookies = await this.loadRedditAuthState(profileKey);
    if (!cookies?.length) {
      throw new Error('The saved Reddit browser profile is not logged in.');
    }
    await this.saveRedditBrowserState(profileKey, cookies);
  }

  private async saveRedditAuthState(
    context: BrowserContext,
    profileKey: string
  ) {
    const cookies = (await this.readBrowserCookies(context)).filter(
      ({ domain }) => redditDomain(domain)
    );
    if (
      !cookies.some(
        ({ name, value }) =>
          ['reddit_session', 'token_v2'].includes(name) && Boolean(value)
      )
    ) {
      throw new Error(
        'Reddit did not provide an authenticated session cookie.'
      );
    }
    const directory = profilePath(profileKey);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    const path = authStatePath(profileKey);
    await writeFile(path, encryptCookieState(cookies), { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(path, 0o600);
    await this.saveRedditBrowserState(profileKey, cookies);
  }

  private async loadRedditAuthState(profileKey: string) {
    try {
      return decryptCookieState(
        await readFile(authStatePath(profileKey), 'utf8')
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async readBrowserCookies(
    context: BrowserContext
  ): Promise<RedditCookieState> {
    try {
      return await context.cookies();
    } catch (error) {
      if (!/Browser context management is not supported/i.test(String(error))) {
        throw error;
      }
      const page = context.pages()[0];
      if (!page) return [];
      const cdp = await context.newCDPSession(page);
      try {
        const result = (await cdp.send('Network.getAllCookies')) as {
          cookies?: Array<{
            name: string;
            value: string;
            domain: string;
            path: string;
            expires: number;
            httpOnly: boolean;
            secure: boolean;
            sameSite?: 'Strict' | 'Lax' | 'None';
          }>;
        };
        return (result.cookies || []).map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
        }));
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    }
  }

  private async writeBrowserCookies(
    context: BrowserContext,
    cookies: RedditCookieState
  ) {
    try {
      await context.addCookies(cookies);
      return;
    } catch (error) {
      if (!/Browser context management is not supported/i.test(String(error))) {
        throw error;
      }
    }
    const page = context.pages()[0] || (await context.newPage());
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send('Network.setCookies', {
        cookies: cookies.map(
          ({ expires, partitionKey: _partitionKey, ...cookie }) => ({
            ...cookie,
            ...(expires >= 0 ? { expires } : {}),
          })
        ),
      });
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  private async launchProfile(profileKey: string) {
    return await this.launchUnflaggedLoginProfile(profileKey);
  }

  private async launchBrowserless(profileKey: string) {
    const config = browserlessConfig();
    if (!config) throw new Error('Browserless remote login is not configured.');
    const profileUrl = new URL('/profile', config.origin);
    profileUrl.searchParams.set('timeout', String(REMOTE_LOGIN_TIMEOUT_MS));
    if (config.token) profileUrl.searchParams.set('token', config.token);
    const response = await fetch(profileUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `postiz-reddit-${profileKey}-${randomBytes(6).toString('hex')}`,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        `Browserless could not create the Reddit login browser (${response.status}).`
      );
    }
    const session = (await response.json()) as {
      connect?: string;
      stop?: string;
    };
    if (!session.connect || !/^wss?:\/\//i.test(session.connect)) {
      throw new Error('Browserless returned an invalid connection URL.');
    }
    const browser = await chromium.connectOverCDP(session.connect, {
      timeout: 60_000,
    });
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      throw new Error('Browserless did not provide a browser context.');
    }
    return {
      browser,
      context,
      browserName: 'Browserless Chrome',
      remoteStopUrl: session.stop,
    };
  }

  private async launchUnflaggedLoginProfile(profileKey: string) {
    if (activeProfiles.has(profileKey)) {
      throw new Error('This Reddit browser profile is already in use.');
    }
    const directory = profilePath(profileKey);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    const chrome = browserExecutable();
    const port = await availableLoopbackPort();
    const args = [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${directory}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-save-password-bubble',
      '--disable-features=PasswordManagerOnboarding',
      '--window-size=1280,900',
    ];
    if (loginHeadless()) args.push('--headless=new');
    args.push('about:blank');
    activeProfiles.add(profileKey);
    const browserProcess = spawn(chrome.executablePath, args, {
      stdio: 'ignore',
      windowsHide: true,
    });
    browserProcess.once('exit', () => activeProfiles.delete(profileKey));
    try {
      const endpoint = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (browserProcess.exitCode !== null) {
          throw new Error(
            'Chrome exited before its private profile was ready.'
          );
        }
        try {
          const response = await fetch(`${endpoint}/json/version`, {
            signal: AbortSignal.timeout(1_000),
          });
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          // Chrome is still starting.
        }
        await wait(100);
      }
      if (!ready) throw new Error('Chrome did not open its private profile.');
      const browser = await chromium.connectOverCDP(endpoint, {
        timeout: 30_000,
      });
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close().catch(() => undefined);
        throw new Error('Chrome did not provide a browser context.');
      }
      const savedCookies = await this.loadRedditAuthState(profileKey);
      if (savedCookies?.length) {
        await this.writeBrowserCookies(context, savedCookies);
      }
      browser.once('disconnected', () => activeProfiles.delete(profileKey));
      return {
        browser,
        browserProcess,
        context,
        browserName: `${chrome.browserName} (native)`,
      };
    } catch (error) {
      activeProfiles.delete(profileKey);
      if (browserProcess.exitCode === null) browserProcess.kill('SIGTERM');
      throw error;
    }
  }

  private async createInteractiveViewer(state: InteractiveLogin, page: Page) {
    if (!state.context) return;
    const cdp = await state.context.newCDPSession(page);
    state.cdp = cdp;
    state.viewerId = randomBytes(18).toString('base64url');
    state.frameVersion = 0;
    cdp.on(
      'Page.screencastFrame',
      (event: {
        data: string;
        sessionId: number;
        metadata?: { deviceWidth?: number; deviceHeight?: number };
      }) => {
        state.frameData = event.data;
        state.frameWidth = Math.max(
          1,
          Math.round(event.metadata?.deviceWidth || 1280)
        );
        state.frameHeight = Math.max(
          1,
          Math.round(event.metadata?.deviceHeight || 900)
        );
        state.frameVersion = (state.frameVersion || 0) + 1;
        void cdp
          .send('Page.screencastFrameAck', { sessionId: event.sessionId })
          .catch(() => undefined);
      }
    );
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1280,
      maxHeight: 900,
      everyNthFrame: 2,
    });
    if (!state.remote) return;
    const sendBrowserless = cdp.send.bind(cdp) as (
      method: string,
      params?: Record<string, unknown>
    ) => Promise<unknown>;
    const result = (await sendBrowserless('Browserless.liveURL', {
      timeout: 9 * 60_000,
      interactable: true,
      resizable: true,
      showBrowserInterface: true,
      quality: 70,
      type: 'jpeg',
      compressed: true,
      emulateComponents: true,
    })) as { error?: string | null; liveURL?: string; liveURLId?: string };
    if (result.error || !result.liveURL || !result.liveURLId) {
      return;
    }
    state.liveUrlId = result.liveURLId;
    state.viewerUrl = result.liveURL;
  }

  private async closeContext(state: InteractiveLogin) {
    if (state.expiryTimer) clearTimeout(state.expiryTimer);
    state.expiryTimer = undefined;
    const context = state.context;
    const browser = state.browser;
    const browserProcess = state.browserProcess;
    const cdp = state.cdp;
    const liveUrlId = state.liveUrlId;
    const remoteStopUrl = state.remoteStopUrl;
    state.context = undefined;
    state.browser = undefined;
    state.browserProcess = undefined;
    state.page = undefined;
    state.cdp = undefined;
    state.liveUrlId = undefined;
    state.viewerUrl = undefined;
    state.viewerId = undefined;
    state.frameData = undefined;
    state.frameWidth = undefined;
    state.frameHeight = undefined;
    state.frameVersion = undefined;
    state.remoteStopUrl = undefined;
    if (cdp && liveUrlId) {
      const sendBrowserless = cdp.send.bind(cdp) as (
        method: string,
        params?: Record<string, unknown>
      ) => Promise<unknown>;
      await sendBrowserless('Browserless.closeLiveURL', {
        liveURLId: liveUrlId,
      }).catch(() => undefined);
    }
    await cdp?.send('Page.stopScreencast').catch(() => undefined);
    await cdp?.detach().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    else await context?.close().catch(() => undefined);
    if (browserProcess?.exitCode === null) browserProcess.kill('SIGTERM');
    if (remoteStopUrl) {
      try {
        const stopUrl = new URL(remoteStopUrl);
        stopUrl.searchParams.set('force', 'true');
        await fetch(stopUrl, {
          method: 'DELETE',
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
      } catch {
        // The Browserless session is already closed or returned no valid stop URL.
      }
    }
  }

  private scheduleAgent(
    state: InteractiveLogin,
    observation: RedditAgentLoginObservation
  ) {
    const fingerprint = JSON.stringify(observation);
    if (state.agentFingerprint === fingerprint) return;
    state.agentFingerprint = fingerprint;
    state.agentAbort?.abort();
    const controller = new AbortController();
    state.agentAbort = controller;
    state.agentUi = fallbackRedditAgentLoginUi(observation);
    const decision = this.redditLoginAgent
      .decide(observation, controller.signal)
      .then((ui) => {
        if (
          !controller.signal.aborted &&
          state.agentFingerprint === fingerprint
        ) {
          state.agentUi = ui;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (state.agentDecision === decision) state.agentDecision = undefined;
        if (state.agentAbort === controller) state.agentAbort = undefined;
      });
    state.agentDecision = decision;
  }

  private statusResponse(state: InteractiveLogin) {
    return {
      status: state.status,
      message: state.message,
      loginState: state.loginState,
      loginMethod: state.loginMethod,
      username: state.username,
      browserName: state.browserName,
      connectionCode: state.connectionCode,
      viewerPath: state.viewerId
        ? `/integrations/reddit-agent/browser/${encodeURIComponent(
            state.viewerId
          )}`
        : undefined,
      remote: Boolean(state.remote),
      otpRequired: state.loginState === 'two_factor_required',
      agentEnabled: this.redditLoginAgent.isEnabled(),
      agentUi: state.agentUi,
    };
  }

  async startInteractiveLogin(
    key: string,
    value: {
      username?: string;
      password?: string;
      profileName?: string;
      method?: RedditAgentLoginMethod;
    }
  ) {
    const method: RedditAgentLoginMethod = [
      'google',
      'apple',
      'phone',
      'email_link',
      'sso',
    ].includes(value.method || '')
      ? (value.method as RedditAgentLoginMethod)
      : 'password';
    const username = value.username?.trim() || '';
    const password = value.password || '';
    const defaultProfileNames: Record<RedditAgentLoginMethod, string> = {
      password: username || 'Reddit Browser Account',
      google: 'Reddit Google Account',
      apple: 'Reddit Apple Account',
      phone: 'Reddit Phone Account',
      email_link: 'Reddit Email Link Account',
      sso: 'Reddit SSO Account',
    };
    const profileName =
      value.profileName?.trim() || defaultProfileNames[method];
    const validUsername = /^[A-Za-z0-9_-]{3,64}$/.test(username);
    const validEmail =
      username.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username);
    if (method === 'password' && !validUsername && !validEmail) {
      throw new Error('Enter a valid Reddit email address or username.');
    }
    if (method === 'password' && (!password || password.length > 256)) {
      throw new Error('Enter a valid Reddit password.');
    }
    if (!profileName || profileName.length > 80) {
      throw new Error('The account label must be 80 characters or fewer.');
    }

    const previous = interactiveLogins.get(key);
    previous?.agentAbort?.abort();
    if (previous) {
      await this.closeContext(previous).catch(() => undefined);
    }

    const profileKey = createHash('sha256')
      .update(
        `${key}\0${
          method === 'password'
            ? username.toLowerCase()
            : `${method}:${profileName.toLowerCase()}`
        }`
      )
      .digest('hex')
      .slice(0, 32);
    const state: InteractiveLogin = {
      status: 'running',
      message: 'Starting a private Chrome or Chromium profile…',
      loginState: 'starting_browser',
      username: username || undefined,
      pendingPassword: method === 'password' ? password : undefined,
      loginMethod: method,
      pendingExternalStart: method !== 'password',
      profileKey,
      profileName,
    };
    interactiveLogins.set(key, state);
    state.expiryTimer = setTimeout(() => {
      if (state.status !== 'running') return;
      state.status = 'error';
      state.loginState = 'failed';
      state.pendingPassword = undefined;
      state.message = 'The Reddit browser login expired after ten minutes.';
      this.scheduleAgent(state, {
        loginState: 'failed',
        browserName: state.browserName,
        lastError: state.message,
      });
      void this.closeContext(state);
    }, 10 * 60_000);
    state.expiryTimer.unref?.();
    this.scheduleAgent(state, { loginState: 'starting_browser' });

    try {
      const remote = useRemoteLogin();
      const launched = remote
        ? await this.launchBrowserless(profileKey)
        : await this.launchUnflaggedLoginProfile(profileKey);
      state.context = launched.context;
      state.browser = launched.browser;
      if ('browserProcess' in launched) {
        state.browserProcess = launched.browserProcess;
      }
      if ('remoteStopUrl' in launched) {
        state.remoteStopUrl = launched.remoteStopUrl;
      }
      state.remote = remote;
      state.browserName = launched.browserName;
      const { context } = launched;
      const page = context.pages()[0] || (await context.newPage());
      state.page = page;
      await page.goto('https://www.reddit.com/login/', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });

      if (await this.hasAuthenticatedCookie(context)) {
        await this.completeLogin(state);
        return this.statusResponse(state);
      }

      if (method === 'password') {
        if (await this.submitCredentials(state)) {
          await page.waitForTimeout(1_500);
        }
      } else if (await this.startExternalLogin(state)) {
        await page.waitForTimeout(750);
      }
      await this.createInteractiveViewer(state, context.pages().at(-1) || page);
      state.message = remote
        ? 'The secure cloud browser stream is ready. Complete Reddit login below.'
        : 'The interactive browser stream is ready. Complete Reddit login below.';
      await this.inspectLogin(state);
      return this.statusResponse(state);
    } catch (error) {
      state.status = 'error';
      state.loginState = 'failed';
      state.message =
        error instanceof Error
          ? error.message
          : 'Unable to start Reddit login.';
      state.pendingPassword = undefined;
      this.scheduleAgent(state, {
        loginState: 'failed',
        browserName: state.browserName,
        lastError: state.message,
      });
      await this.closeContext(state);
      throw error;
    }
  }

  async getInteractiveLoginStatus(key: string) {
    const state = interactiveLogins.get(key);
    if (!state) {
      return this.statusResponse({
        status: 'idle',
        message: 'Enter Reddit credentials to start a private browser login.',
        loginState: 'starting_browser',
      });
    }
    if (state.status !== 'running') return this.statusResponse(state);
    if (!state.statusCheck) {
      state.statusCheck = this.inspectLogin(state).finally(() => {
        state.statusCheck = undefined;
      });
    }
    await state.statusCheck;
    return this.statusResponse(state);
  }

  getInteractiveLoginViewer(key: string, viewerId: string) {
    const state = interactiveLogins.get(key);
    if (
      !state ||
      state.status !== 'running' ||
      !state.viewerId ||
      state.viewerId !== viewerId
    ) {
      throw new Error('This Reddit login viewer is unavailable or expired.');
    }
    return {
      externalViewerUrl: state.viewerUrl,
      externalViewerAvailable: Boolean(state.viewerUrl),
    };
  }

  getInteractiveLoginFrame(key: string, viewerId: string) {
    const state = interactiveLogins.get(key);
    if (
      !state ||
      state.status !== 'running' ||
      !state.viewerId ||
      state.viewerId !== viewerId ||
      !state.cdp
    ) {
      throw new Error('This Reddit login browser is unavailable or expired.');
    }
    return {
      frame: state.frameData
        ? `data:image/jpeg;base64,${state.frameData}`
        : undefined,
      width: state.frameWidth || 1280,
      height: state.frameHeight || 900,
      version: state.frameVersion || 0,
    };
  }

  async sendInteractiveLoginInput(
    key: string,
    viewerId: string,
    input: RedditAgentBrowserInput
  ) {
    const state = interactiveLogins.get(key);
    if (
      !state ||
      state.status !== 'running' ||
      !state.viewerId ||
      state.viewerId !== viewerId ||
      !state.cdp
    ) {
      throw new Error('This Reddit login browser is unavailable or expired.');
    }
    const cdp = state.cdp;
    const coordinate = (value: unknown, maximum: number) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('The browser input coordinates are invalid.');
      }
      return Math.min(maximum, Math.max(0, value));
    };
    const wheelDelta = (value: unknown) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('The browser wheel input is invalid.');
      }
      return Math.min(2_000, Math.max(-2_000, value));
    };
    if (input.kind === 'mouse') {
      const types = {
        move: 'mouseMoved',
        down: 'mousePressed',
        up: 'mouseReleased',
      } as const;
      await cdp.send('Input.dispatchMouseEvent', {
        type: types[input.type],
        x: coordinate(input.x, state.frameWidth || 1280),
        y: coordinate(input.y, state.frameHeight || 900),
        button: input.button || (input.type === 'move' ? 'none' : 'left'),
        buttons: input.type === 'down' ? 1 : 0,
        clickCount: input.type === 'move' ? 0 : 1,
      });
    } else if (input.kind === 'wheel') {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: coordinate(input.x, state.frameWidth || 1280),
        y: coordinate(input.y, state.frameHeight || 900),
        deltaX: wheelDelta(input.deltaX),
        deltaY: wheelDelta(input.deltaY),
      });
    } else if (input.kind === 'text') {
      if (typeof input.text !== 'string' || input.text.length > 2_000) {
        throw new Error('The browser text input is invalid.');
      }
      await cdp.send('Input.insertText', { text: input.text });
    } else if (input.kind === 'key') {
      if (
        typeof input.key !== 'string' ||
        !input.key ||
        input.key.length > 40 ||
        (input.code && input.code.length > 40) ||
        (input.text && input.text.length > 8)
      ) {
        throw new Error('The browser keyboard input is invalid.');
      }
      await cdp.send('Input.dispatchKeyEvent', {
        type: input.type === 'down' ? 'keyDown' : 'keyUp',
        key: input.key,
        code: input.code,
        text: input.type === 'down' ? input.text : undefined,
        modifiers: Math.min(15, Math.max(0, input.modifiers || 0)),
      });
    } else {
      throw new Error('The browser input type is invalid.');
    }
    return { success: true };
  }

  async cancelInteractiveLogin(key: string) {
    const state = interactiveLogins.get(key);
    if (!state || state.status !== 'running') return { success: true };
    state.status = 'error';
    state.loginState = 'failed';
    state.pendingPassword = undefined;
    state.message = 'The Reddit browser login was cancelled.';
    state.agentAbort?.abort();
    await this.closeContext(state);
    return { success: true };
  }

  private async hasAuthenticatedCookie(context: BrowserContext) {
    const cookies = (await this.readBrowserCookies(context)).filter(
      ({ domain }) => redditDomain(domain)
    );
    const hasSessionCookie = cookies.some(
      (cookie) =>
        ['reddit_session', 'token_v2'].includes(cookie.name) &&
        Boolean(cookie.value)
    );
    if (!hasSessionCookie) return false;
    return Boolean(await this.authenticatedUsername(context));
  }

  private async authenticatedUsername(context: BrowserContext) {
    const redditPage = context.pages().find((page) => {
      try {
        return redditDomain(new URL(page.url()).hostname);
      } catch {
        return false;
      }
    });
    if (redditPage) {
      try {
        const username = await redditPage.evaluate(async () => {
          const response = await fetch('/api/me.json?raw_json=1', {
            credentials: 'include',
          });
          if (!response.ok) return '';
          const result = await response.json();
          return typeof result?.data?.name === 'string' ? result.data.name : '';
        });
        if (username.trim()) return username.trim().slice(0, 64);
      } catch {
        // Fall back to an isolated request when the Reddit page is unavailable.
      }
    }
    try {
      const response = await context.request.get(
        'https://www.reddit.com/api/me.json?raw_json=1',
        { timeout: 15_000 }
      );
      if (!response.ok()) return undefined;
      const username = (await response.json())?.data?.name;
      return typeof username === 'string' && username.trim()
        ? username.trim().slice(0, 64)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async completeLogin(state: InteractiveLogin) {
    if (!state.profileKey || !state.profileName || !state.context) {
      throw new Error('Reddit login profile information is incomplete.');
    }
    state.username = await this.resolveUsername(
      state.context,
      state.username || state.profileName
    );
    await this.saveRedditAuthState(state.context, state.profileKey);
    const credentials: RedditAgentCredentials = {
      profileKey: state.profileKey,
      profileName: state.profileName,
      username: state.username,
      ...this.mcpCredentials(state.profileName),
    };
    state.status = 'success';
    state.loginState = 'authenticated';
    state.message = `Authenticated as ${state.username}. The browser profile was saved.`;
    state.connectionCode = this.encodeRedditCredentials(credentials);
    state.pendingPassword = undefined;
    state.pendingExternalStart = false;
    this.scheduleAgent(state, {
      loginState: 'authenticated',
      browserName: state.browserName,
    });
    await this.closeContext(state);
  }

  private async finishAuthenticatedLogin(state: InteractiveLogin) {
    if (!state.completion) {
      state.completion = this.completeLogin(state).finally(() => {
        state.completion = undefined;
      });
    }
    await state.completion;
  }

  private async inspectLogin(state: InteractiveLogin) {
    if (state.status !== 'running') return;
    if (!state.context || !state.page) {
      if (state.status === 'running') {
        state.status = 'error';
        state.loginState = 'failed';
        state.message = 'The Reddit browser session is no longer running.';
      }
      return;
    }
    if (await this.hasAuthenticatedCookie(state.context)) {
      await this.finishAuthenticatedLogin(state);
      return;
    }

    if (state.status !== 'running' || !state.page) return;

    const page = state.page;
    const text = `${await page.title().catch(() => '')} ${await safePageText(
      page
    )}`;
    if (state.pendingPassword && (await this.submitCredentials(state))) {
      await page.waitForTimeout(1_500);
      if (await this.hasAuthenticatedCookie(state.context)) {
        await this.finishAuthenticatedLogin(state);
        return;
      }
    }
    if (state.pendingExternalStart && (await this.startExternalLogin(state))) {
      await page.waitForTimeout(750);
      if (await this.hasAuthenticatedCookie(state.context)) {
        await this.finishAuthenticatedLogin(state);
        return;
      }
    }
    if (state.loginMethod && state.loginMethod !== 'password') {
      const externalPage = state.context.pages().find((candidate) => {
        try {
          const hostname = new URL(candidate.url()).hostname;
          return Boolean(hostname) && !redditDomain(hostname);
        } catch {
          return false;
        }
      });
      if (externalPage) {
        const methodLabel = this.loginMethodLabel(state.loginMethod);
        const externalText = `${await externalPage
          .title()
          .catch(() => '')} ${await safePageText(externalPage)}`;
        if (
          /this browser or app may not be secure|couldn.t sign you in/i.test(
            externalText
          )
        ) {
          state.loginState = 'challenge_required';
          state.message =
            'Google rejected this controlled browser. Use Reddit’s direct login or open the sign-in in your own browser.';
          this.scheduleAgent(state, {
            loginState: state.loginState,
            loginMethod: state.loginMethod,
            browserName: state.browserName,
            lastError: state.message,
          });
          return;
        }
        state.loginState = 'external_login_in_progress';
        state.message = `Complete ${methodLabel} sign-in in the interactive browser. Postiz will only retain the resulting Reddit session.`;
        this.scheduleAgent(state, {
          loginState: state.loginState,
          loginMethod: state.loginMethod,
          browserName: state.browserName,
        });
        return;
      }
    }
    const otp = await firstVisible(page, [
      'input[name="otp"]',
      'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"]',
    ]);
    if (
      otp ||
      /two[- ]factor|authenticator code|verification code|6-digit code/i.test(
        text
      )
    ) {
      state.loginState = 'two_factor_required';
      state.message = 'Reddit requires a six-digit authenticator code.';
      this.scheduleAgent(state, {
        loginState: state.loginState,
        browserName: state.browserName,
      });
      return;
    }

    const challenge =
      (await page
        .locator('iframe[src*="captcha"], iframe[title*="challenge" i]')
        .count()) > 0 ||
      /captcha|prove your humanity|prove you.?re human|security check|verify you are human/i.test(
        text
      );
    if (challenge) {
      state.loginState = 'challenge_required';
      state.message = state.remote
        ? 'Complete Reddit’s security challenge in the interactive cloud browser.'
        : loginHeadless()
        ? 'Reddit requires an interactive browser challenge. Set REDDIT_AGENT_HEADLESS=false and restart this login.'
        : 'Complete Reddit’s security challenge in the opened browser.';
      this.scheduleAgent(state, {
        loginState: state.loginState,
        browserName: state.browserName,
      });
      return;
    }

    if (
      /incorrect username or password|invalid password|wrong password|unable to log in/i.test(
        text
      )
    ) {
      state.status = 'error';
      state.loginState = 'invalid_credentials';
      state.message = 'Reddit rejected the username or password.';
      state.pendingPassword = undefined;
      this.scheduleAgent(state, {
        loginState: state.loginState,
        browserName: state.browserName,
      });
      await this.closeContext(state);
      return;
    }

    if (state.loginMethod && state.loginMethod !== 'password') {
      const methodLabel = this.loginMethodLabel(state.loginMethod);
      state.loginState = 'external_login_in_progress';
      state.message = state.pendingExternalStart
        ? `Continue with ${methodLabel} in the opened browser. Reddit may require a security check before showing that option.`
        : `Complete ${methodLabel} sign-in in the opened browser. Postiz is waiting for Reddit to create the session.`;
      this.scheduleAgent(state, {
        loginState: state.loginState,
        loginMethod: state.loginMethod,
        browserName: state.browserName,
      });
      return;
    }

    state.loginState = 'submitting_credentials';
    state.message = 'Waiting for Reddit to finish the login…';
    this.scheduleAgent(state, {
      loginState: state.loginState,
      browserName: state.browserName,
    });
  }

  private async submitCredentials(state: InteractiveLogin) {
    if (!state.page || !state.username || !state.pendingPassword) return false;
    const usernameInput = await firstVisible(state.page, [
      'input[name="username"]',
      'input#loginUsername',
      'input[autocomplete="username"]',
    ]);
    const passwordInput = await firstVisible(state.page, [
      'input[name="password"]',
      'input#loginPassword',
      'input[autocomplete="current-password"]',
    ]);
    if (!usernameInput || !passwordInput) return false;

    state.loginState = 'submitting_credentials';
    state.message = 'Submitting credentials directly to Reddit…';
    this.scheduleAgent(state, {
      loginState: state.loginState,
      browserName: state.browserName,
    });
    const password = state.pendingPassword;
    try {
      await usernameInput.fill(state.username);
      await passwordInput.fill(password);
      const submit = await firstVisible(state.page, [
        'button[type="submit"]',
        'button:has-text("Log In")',
        'button:has-text("Continue")',
      ]);
      if (!submit) throw new Error('Reddit login button was not found.');
      await submit.click();
      return true;
    } finally {
      state.pendingPassword = undefined;
    }
  }

  private loginMethodLabel(method: RedditAgentLoginMethod) {
    if (method === 'phone') return 'phone number';
    if (method === 'email_link') return 'email link';
    if (method === 'sso') return 'SSO';
    return method.charAt(0).toUpperCase() + method.slice(1);
  }

  private async startExternalLogin(state: InteractiveLogin) {
    if (
      !state.page ||
      !state.pendingExternalStart ||
      !state.loginMethod ||
      state.loginMethod === 'password'
    ) {
      return false;
    }
    const selectors: Record<
      Exclude<RedditAgentLoginMethod, 'password'>,
      string[]
    > = {
      google: [
        'button:has-text("Continue with Google")',
        'button:has-text("Sign in with Google")',
        '[data-testid="google-sso-button"]',
        '[aria-label*="Google" i]',
      ],
      apple: [
        'button:has-text("Continue with Apple")',
        'button:has-text("Sign in with Apple")',
        '[data-testid="apple-sso-button"]',
        '[aria-label*="Apple" i]',
      ],
      phone: [
        'button:has-text("Continue with phone number")',
        'button:has-text("Continue with Phone Number")',
        'button:has-text("Continue with phone")',
        '[data-testid="phone-sso-button"]',
        '[aria-label*="phone number" i]',
      ],
      email_link: [
        'button:has-text("Email me a one-time link")',
        '[role="button"]:has-text("Email me a one-time link")',
        'button:has-text("one-time link")',
      ],
      sso: [
        'button:has-text("Continue with SSO")',
        '[role="button"]:has-text("Continue with SSO")',
        '[aria-label*="SSO" i]',
      ],
    };
    const loginButton = await firstVisible(
      state.page,
      selectors[state.loginMethod]
    );
    if (!loginButton) return false;
    state.pendingExternalStart = false;
    state.loginState = 'external_login_in_progress';
    const methodLabel = this.loginMethodLabel(state.loginMethod);
    state.message = `Complete ${methodLabel} sign-in in the opened browser. Those credentials stay in that browser.`;
    this.scheduleAgent(state, {
      loginState: state.loginState,
      loginMethod: state.loginMethod,
      browserName: state.browserName,
    });
    await loginButton.click();
    return true;
  }

  private async resolveUsername(
    context: BrowserContext,
    fallback: string
  ): Promise<string> {
    const authenticated = await this.authenticatedUsername(context);
    if (authenticated) return authenticated;
    try {
      const response = await context.request.get(
        'https://www.reddit.com/api/me.json?raw_json=1',
        { timeout: 20_000 }
      );
      if (response.ok()) {
        const username = (await response.json())?.data?.name;
        if (typeof username === 'string' && username.trim()) {
          return username.trim().slice(0, 64);
        }
      }
    } catch {
      // Keep the user-provided account label as the safe display fallback.
    }
    return fallback.slice(0, 64);
  }

  async submitInteractiveLoginCode(key: string, code: string) {
    if (!TWO_FACTOR_CODE_PATTERN.test(code)) {
      throw new Error('The Reddit verification code must contain six digits.');
    }
    const state = interactiveLogins.get(key);
    if (
      !state ||
      state.status !== 'running' ||
      state.loginState !== 'two_factor_required' ||
      !state.page
    ) {
      throw new Error(
        'Reddit is not currently requesting a verification code.'
      );
    }
    if (state.otpSubmission) {
      throw new Error('A verification code is already being submitted.');
    }

    state.loginState = 'submitting_two_factor';
    state.message = 'Submitting the verification code directly to Reddit…';
    this.scheduleAgent(state, {
      loginState: state.loginState,
      browserName: state.browserName,
    });
    state.otpSubmission = (async () => {
      const input = await firstVisible(state.page!, [
        'input[name="otp"]',
        'input[autocomplete="one-time-code"]',
        'input[inputmode="numeric"]',
      ]);
      if (!input) throw new Error('Reddit verification field was not found.');
      await input.fill(code);
      const submit = await firstVisible(state.page!, [
        'button[type="submit"]',
        'button:has-text("Continue")',
        'button:has-text("Verify")',
      ]);
      if (!submit) throw new Error('Reddit verification button was not found.');
      await submit.click();
      await state.page!.waitForTimeout(1_500);
      await this.inspectLogin(state);
    })().finally(() => {
      state.otpSubmission = undefined;
    });
    await state.otpSubmission;
    return this.statusResponse(state);
  }

  private async verifyCredentials(credentials: RedditAgentCredentials) {
    const launched = await this.launchProfile(credentials.profileKey);
    const { context } = launched;
    try {
      if (await this.hasAuthenticatedCookie(context)) return true;
      const page = context.pages()[0] || (await context.newPage());
      await page.goto('https://www.reddit.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      return await this.hasAuthenticatedCookie(context);
    } finally {
      await launched.browser.close().catch(() => undefined);
      if (launched.browserProcess.exitCode === null) {
        launched.browserProcess.kill('SIGTERM');
      }
    }
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }): Promise<AuthTokenDetails | string> {
    try {
      const credentials = this.decodeRedditCredentials(params.code);
      await this.ensureRedditBrowserState(credentials.profileKey);
      const status = JSON.parse(
        await this.mcpBridge.callMcpTool(
          credentials,
          'reddit_check_login',
          { profile_key: credentials.profileKey },
          90_000
        )
      ) as { logged_in?: boolean; username?: string; message?: string };
      if (!status.logged_in) {
        return (
          status.message || 'The saved Reddit browser profile is not logged in.'
        );
      }
      return {
        id: credentials.profileKey,
        name: credentials.profileName,
        username: status.username || credentials.username,
        accessToken: params.code,
        refreshToken: params.code,
        expiresIn: 60 * 60 * 24 * 365,
        picture: '/icons/platforms/reddit.png',
      };
    } catch (error) {
      return error instanceof Error
        ? error.message
        : 'Reddit Agent login check failed.';
    }
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    const credentials = this.decodeRedditCredentials(refreshToken);
    return {
      id: credentials.profileKey,
      name: credentials.profileName,
      username: credentials.username,
      accessToken: refreshToken,
      refreshToken,
      expiresIn: 60 * 60 * 24 * 365,
      picture: '/icons/platforms/reddit.png',
    };
  }

  private async withProfile<T>(
    accessToken: string,
    callback: (context: BrowserContext, page: Page) => Promise<T>
  ) {
    const credentials = this.decodeRedditCredentials(accessToken);
    const launched = await this.launchProfile(credentials.profileKey);
    const { context } = launched;
    try {
      if (!(await this.hasAuthenticatedCookie(context))) {
        throw new Error('The Reddit browser session expired. Reconnect it.');
      }
      const page = context.pages()[0] || (await context.newPage());
      return await callback(context, page);
    } finally {
      await launched.browser.close().catch(() => undefined);
      if (launched.browserProcess.exitCode === null) {
        launched.browserProcess.kill('SIGTERM');
      }
    }
  }

  private async selectFlair(page: Page, flair?: { id: string; name: string }) {
    if (!flair?.name) return;
    const open = page.locator('.flairselectbtn').first();
    if (!(await isVisible(open))) return;
    await open.click();
    const row = page
      .locator('.flairselector .flairrow')
      .filter({ hasText: flair.name })
      .first();
    if (await isVisible(row)) await row.click();
    const apply = page.locator('.flairselector button[type="submit"]').first();
    if (await isVisible(apply)) await apply.click();
  }

  private async publishOne(
    page: Page,
    entry: RedditSettingsDto['subreddit'][number]['value'],
    message: string,
    mediaPath?: string
  ) {
    const subreddit = entry.subreddit.replace(/^\/?r\//i, '');
    if (!/^[A-Za-z0-9_]{2,32}$/.test(subreddit)) {
      throw new Error(`Invalid subreddit: ${entry.subreddit}`);
    }
    const mode = entry.type === 'self' ? 'selftext=true' : 'url=true';
    await page.goto(`https://old.reddit.com/r/${subreddit}/submit?${mode}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    if (/\/login(?:\/|\?|$)/.test(new URL(page.url()).pathname)) {
      throw new Error('The Reddit browser session expired. Reconnect it.');
    }

    const title = page
      .locator('textarea[name="title"], input[name="title"]')
      .first();
    await title.waitFor({ state: 'visible', timeout: 30_000 });
    await title.fill(entry.title);
    if (entry.type === 'self') {
      const body = page.locator('textarea[name="text"]').first();
      await body.waitFor({ state: 'visible', timeout: 15_000 });
      await body.fill(message);
    } else if (entry.type === 'link') {
      const url = page.locator('input[name="url"]').first();
      await url.waitFor({ state: 'visible', timeout: 15_000 });
      await url.fill(entry.url);
    } else if (entry.type === 'media') {
      if (!mediaPath || /^https?:/i.test(mediaPath)) {
        throw new Error('Reddit Agent media publishing requires a local file.');
      }
      const file = page.locator('input[type="file"]').first();
      await file.waitFor({ state: 'attached', timeout: 15_000 });
      await file.setInputFiles(mediaPath);
    }
    await this.selectFlair(page, entry.flair);

    const submit = page.locator('button[name="submit"]').first();
    await submit.click();
    await page
      .waitForURL(/\/comments\//, { timeout: 90_000 })
      .catch(() => undefined);
    if (!/\/comments\//.test(page.url())) {
      const error = await page
        .locator('.error, #status')
        .allInnerTexts()
        .catch(() => [] as string[]);
      throw new Error(
        error.filter(Boolean).join(' ') ||
          `Reddit did not confirm the post to r/${subreddit}.`
      );
    }
    const match = page.url().match(/\/comments\/([A-Za-z0-9]+)/);
    return {
      postId: match?.[1] || '',
      releaseURL: page.url(),
    };
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<RedditSettingsDto>[],
    _integration: Integration
  ): Promise<PostResponse[]> {
    const post = postDetails[0];
    if (!post?.settings?.subreddit?.length) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'Choose at least one subreddit.'
      );
    }
    try {
      const credentials = this.decodeRedditCredentials(accessToken);
      await this.ensureRedditBrowserState(credentials.profileKey);
      const mediaPath = post.media?.[0]?.path
        ? await this.mcpBridge.localOrPublicMediaPath(post.media[0].path)
        : '';
      const results: Array<{ post_id: string; url: string }> = [];
      for (const entry of post.settings.subreddit) {
        const value = entry.value;
        const postType =
          value.type === 'self'
            ? 'self'
            : value.type === 'link'
            ? 'link'
            : 'media';
        const output = await this.mcpBridge.callMcpTool(
          credentials,
          'reddit_publish_post',
          {
            profile_key: credentials.profileKey,
            subreddit: value.subreddit,
            post_type: postType,
            title: value.title,
            body: post.message,
            url: value.url || '',
            media_path: postType === 'media' ? mediaPath : '',
            flair: value.flair?.name || '',
            confirm_publish: true,
          },
          5 * 60_000
        );
        const published = JSON.parse(output) as {
          status?: string;
          post_id?: string;
          url?: string;
          message?: string;
        };
        if (published.status !== 'published' || !published.url) {
          throw new Error(
            published.message ||
              `Reddit did not confirm publication to ${value.subreddit}.`
          );
        }
        results.push({ post_id: published.post_id || '', url: published.url });
      }
      return [
        {
          id: post.id,
          postId: results
            .map((result) => result.post_id)
            .filter(Boolean)
            .join(','),
          releaseURL: results
            .map((result) => result.url)
            .filter(Boolean)
            .join(','),
          status: 'published',
        },
      ];
    } catch (error) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        error instanceof Error ? error.message : 'Reddit publishing failed.'
      );
    }
  }

  @Tool({
    description:
      'List subscribed Reddit communities, or search community names through the Go MCP browser workflow when word is supplied. Read-only.',
    dataSchema: [
      { key: 'word', type: 'string', description: 'Subreddit search text' },
    ],
  })
  async subreddits(accessToken: string, data: { word?: string }) {
    const query = (data.word || '').trim().slice(0, 80);
    const credentials = this.decodeRedditCredentials(accessToken);
    await this.ensureRedditBrowserState(credentials.profileKey);
    const output = await this.mcpBridge.callMcpTool(
      credentials,
      'reddit_list_forums',
      { profile_key: credentials.profileKey, query, limit: 20 },
      90_000
    );
    const response = JSON.parse(output) as {
      forums?: Array<{ name: string; title?: string; url: string }>;
    };
    return (response.forums || []).map((forum) => ({
      id: forum.name,
      title: forum.title || forum.name,
      name: `/r/${forum.name}`,
    }));
  }

  @Tool({
    description:
      'List posts from a Reddit community through the Go MCP browser workflow. Read-only.',
    dataSchema: [
      {
        key: 'subreddit',
        type: 'string',
        description: 'Community such as /r/COROLLA',
      },
      { key: 'sort', type: 'string', description: 'new, hot, top, or rising' },
      {
        key: 'limit',
        type: 'number',
        description: 'Maximum 1 through 50; defaults to 20',
      },
    ],
  })
  async listPosts(
    accessToken: string,
    data: { subreddit: string; sort?: string; limit?: string }
  ) {
    const credentials = this.decodeRedditCredentials(accessToken);
    await this.ensureRedditBrowserState(credentials.profileKey);
    const output = await this.mcpBridge.callMcpTool(
      credentials,
      'reddit_list_posts',
      {
        profile_key: credentials.profileKey,
        subreddit: data.subreddit,
        sort: data.sort || 'new',
        limit: Number(data.limit || 20),
      },
      90_000
    );
    return JSON.parse(output);
  }

  @Tool({
    description:
      'Read one Reddit post and its comments through the Go MCP browser workflow. Read-only.',
    dataSchema: [
      {
        key: 'subreddit',
        type: 'string',
        description: 'Community containing the post',
      },
      { key: 'postId', type: 'string', description: 'Post ID from listPosts' },
      {
        key: 'commentLimit',
        type: 'number',
        description: 'Maximum 1 through 100; defaults to 50',
      },
    ],
  })
  async readPost(
    accessToken: string,
    data: { subreddit: string; postId: string; commentLimit?: string }
  ) {
    const credentials = this.decodeRedditCredentials(accessToken);
    await this.ensureRedditBrowserState(credentials.profileKey);
    const output = await this.mcpBridge.callMcpTool(
      credentials,
      'reddit_read_post',
      {
        profile_key: credentials.profileKey,
        subreddit: data.subreddit,
        post_id: data.postId,
        comment_limit: Number(data.commentLimit || 50),
      },
      90_000
    );
    return JSON.parse(output);
  }

  @Tool({
    description:
      'Publish one top-level Reddit comment through the Go MCP browser workflow. Calling this helper submits the exact body; identical comments by this account are not duplicated.',
    dataSchema: [
      {
        key: 'subreddit',
        type: 'string',
        description: 'Community containing the post',
      },
      {
        key: 'postId',
        type: 'string',
        description: 'Post ID from listPosts or readPost',
      },
      {
        key: 'body',
        type: 'string',
        description: 'Exact comment text to publish',
      },
    ],
  })
  async commentOnPost(
    accessToken: string,
    data: { subreddit: string; postId: string; body: string }
  ) {
    const credentials = this.decodeRedditCredentials(accessToken);
    await this.ensureRedditBrowserState(credentials.profileKey);
    const output = await this.mcpBridge.callMcpTool(
      credentials,
      'reddit_comment_post',
      {
        profile_key: credentials.profileKey,
        subreddit: data.subreddit,
        post_id: data.postId,
        body: data.body,
        confirm_comment: true,
      },
      90_000
    );
    return JSON.parse(output);
  }

  @Tool({
    description:
      'Read subreddit posting restrictions and flairs through the Go MCP browser workflow. Read-only.',
    dataSchema: [
      {
        key: 'subreddit',
        type: 'string',
        description: 'Subreddit path such as /r/selfhosted',
      },
    ],
  })
  async restrictions(accessToken: string, data: { subreddit: string }) {
    const credentials = this.decodeRedditCredentials(accessToken);
    await this.ensureRedditBrowserState(credentials.profileKey);
    const output = await this.mcpBridge.callMcpTool(
      credentials,
      'reddit_get_restrictions',
      {
        profile_key: credentials.profileKey,
        subreddit: data.subreddit,
      },
      90_000
    );
    return JSON.parse(output);
  }

  async customFields() {
    return [
      {
        key: 'profileName',
        label: 'Account label',
        type: 'text' as const,
        validation: '/^.{1,80}$/',
        defaultValue: 'Reddit Browser Account',
        hint: 'The browser profile is isolated per Postiz organization and Reddit username.',
      },
    ];
  }
}
