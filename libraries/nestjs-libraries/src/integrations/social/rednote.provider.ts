import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  Disconnect,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { RedNoteDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/rednote.dto';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { Integration } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  ensureRedNoteBinaries,
  redNoteBinaryPaths,
} from '@gitroom/nestjs-libraries/integrations/social/rednote.binary.installer';

export type RedNoteCredentials = {
  binaryPath: string;
  mcpEndpoint: string;
  profileName: string;
};

type McpEnvelope = {
  jsonrpc?: string;
  id?: number;
  result?: {
    content?: McpContent[];
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code?: number; message?: string; data?: unknown };
};

export type McpContent = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

export type McpToolResult = {
  content: McpContent[];
  text: string;
};

const DEFAULT_MCP_ENDPOINT = 'http://127.0.0.1:18060/mcp';
const SESSION_PREFLIGHT_TIMEOUT_MS = 45_000;
const SESSION_EXPIRED_MESSAGE =
  'The RedNote session has expired. Reconnect the RedNote channel before publishing.';
const startingServers = new Map<string, Promise<void>>();
type RedNoteLoginState =
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

type InteractiveLogin = {
  status: 'idle' | 'running' | 'success' | 'error';
  message: string;
  credentials?: RedNoteCredentials;
  loginSessionId?: string;
  loginState?: RedNoteLoginState;
  otpAttempts?: number;
  otpMaxAttempts?: number;
  qrCode?: string;
  expiresAt?: number;
  cookiePath?: string;
  backupCookiePath?: string;
  hasCookieBackup?: boolean;
  statusCheck?: Promise<void>;
  otpSubmission?: Promise<void>;
  cancelled?: boolean;
};
const interactiveLogins = new Map<string, InteractiveLogin>();
let activeInteractiveLoginKey: string | undefined;

const QR_CODE_LIFETIME_MS = 4 * 60_000;
const MAX_QR_CODE_BYTES = 2 * 1024 * 1024;
const LOGIN_SESSION_ID_PATTERN =
  /(?:登录会话 ID|login session ID)\s*[:：]\s*([A-Za-z0-9_-]{20,128})/i;
const OTP_CODE_PATTERN = /^\d{6}$/;

export class RedNoteProvider extends SocialAbstract implements SocialProvider {
  identifier = 'rednote';
  name = 'RedNote';
  isBetweenSteps = false;
  scopes: string[] = [];
  editor: 'none' | 'normal' | 'markdown' | 'html' = 'normal';
  dto: any = RedNoteDto;
  override maxConcurrentJob = 1;

  maxLength() {
    return 1000;
  }

  override handleErrors(body: string) {
    try {
      const parsed = JSON.parse(body);
      return {
        type: 'bad-body' as const,
        value: parsed?.message || parsed?.error || body,
      };
    } catch {
      return { type: 'bad-body' as const, value: body };
    }
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      refreshToken,
      accessToken: refreshToken,
      expiresIn: 60 * 60 * 24 * 365 * 100,
      id: refreshToken,
      name: 'RedNote',
      picture: '',
      username: 'rednote',
    };
  }

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  protected decodeCredentials(value: string): RedNoteCredentials {
    try {
      const parsed = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8')
      ) as Partial<RedNoteCredentials> & {
        toolPath?: string;
        bridgeUrl?: string;
      };

      return {
        // Existing extension-backed channels contain toolPath/bridgeUrl. Falling
        // back here migrates those channels without requiring users to reconnect.
        binaryPath:
          parsed.binaryPath ||
          process.env.XHS_MCP_BINARY ||
          redNoteBinaryPaths().mcpPath,
        mcpEndpoint:
          parsed.mcpEndpoint ||
          process.env.XHS_MCP_ENDPOINT ||
          DEFAULT_MCP_ENDPOINT,
        profileName: parsed.profileName || 'RedNote Binary Account',
      };
    } catch {
      throw new Error(
        'Invalid RedNote binary configuration. Reconnect the channel.'
      );
    }
  }

  protected setupCredentials(
    value?: Partial<RedNoteCredentials>
  ): RedNoteCredentials {
    const configuredBinary =
      process.env.XHS_MCP_BINARY || redNoteBinaryPaths().mcpPath;
    const binaryPath = value?.binaryPath || configuredBinary;
    if (resolve(binaryPath) !== resolve(configuredBinary)) {
      throw new Error(
        'RedNote setup can only run the MCP binary configured by the server.'
      );
    }

    const mcpEndpoint =
      value?.mcpEndpoint ||
      process.env.XHS_MCP_ENDPOINT ||
      DEFAULT_MCP_ENDPOINT;
    this.validateEndpoint(mcpEndpoint);

    return {
      binaryPath,
      mcpEndpoint,
      profileName: value?.profileName?.trim() || 'RedNote Binary Account',
    };
  }

  async startInteractiveLogin(
    key: string,
    value?: Partial<RedNoteCredentials>
  ) {
    if (activeInteractiveLoginKey) {
      const previous = interactiveLogins.get(activeInteractiveLoginKey);
      if (previous?.status === 'running') {
        previous.status = 'error';
        previous.cancelled = true;
        previous.message =
          'This QR code was replaced by a newer RedNote login request.';
        previous.qrCode = undefined;
      }
    }
    activeInteractiveLoginKey = key;

    const credentials = this.setupCredentials(value);
    interactiveLogins.set(key, {
      status: 'running',
      message: 'Installing and verifying the RedNote tools if needed…',
    });

    let paths;
    try {
      paths = await ensureRedNoteBinaries(credentials.binaryPath);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to install the RedNote tools.';
      interactiveLogins.set(key, { status: 'error', message });
      if (activeInteractiveLoginKey === key) {
        activeInteractiveLoginKey = undefined;
      }
      throw error;
    }
    // Force a fresh sign-in while retaining a recoverable copy if QR creation
    // fails. The MCP service owns the headless browser and writes the new
    // cookies after the phone approves the login.
    const cookiePath = paths.cookiePath;
    const backupCookiePath = join(
      dirname(cookiePath),
      'cookies.postiz-backup.json'
    );
    let hasCookieBackup = false;
    try {
      await copyFile(cookiePath, backupCookiePath);
      hasCookieBackup = true;
    } catch {
      // A first-time connection has no existing cookie to preserve.
    }
    try {
      if (hasCookieBackup) {
        await this.callMcpTool(credentials, 'delete_cookies', {}, 30_000);
      }
      const result = await this.callMcpToolResult(
        credentials,
        'get_login_qrcode',
        {},
        90_000
      );
      const image = result.content.find(
        (item) => item.type === 'image' && item.data
      );
      const qrCode = this.mcpImageDataUrl(image);
      if (!qrCode) {
        throw new Error(result.text || 'RedNote MCP did not return a QR code.');
      }
      const loginSessionId = result.text.match(LOGIN_SESSION_ID_PATTERN)?.[1];
      if (!loginSessionId) {
        throw new Error(
          'The installed RedNote MCP server does not expose an OTP-capable login session. Install the updated MCP binary and try again.'
        );
      }

      const state: InteractiveLogin = {
        status: 'running',
        message:
          'Scan this QR code with the Xiaohongshu app and approve the login.',
        credentials,
        loginSessionId,
        loginState: 'waiting_for_scan',
        otpAttempts: 0,
        otpMaxAttempts: 3,
        qrCode,
        expiresAt: Date.now() + QR_CODE_LIFETIME_MS,
        cookiePath,
        backupCookiePath,
        hasCookieBackup,
      };
      interactiveLogins.set(key, state);
      return this.loginStatusResponse(state);
    } catch (error) {
      if (hasCookieBackup) {
        await copyFile(backupCookiePath, cookiePath).catch(() => undefined);
      }
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to create the RedNote login QR code.';
      const state: InteractiveLogin = { status: 'error', message };
      interactiveLogins.set(key, state);
      if (activeInteractiveLoginKey === key) {
        activeInteractiveLoginKey = undefined;
      }
      throw error;
    }
  }

  private loginStatusResponse(state: InteractiveLogin) {
    return {
      status: state.status,
      message: state.message,
      ...(state.qrCode ? { qrCode: state.qrCode } : {}),
      ...(state.expiresAt
        ? { expiresAt: new Date(state.expiresAt).toISOString() }
        : {}),
      ...(state.loginState ? { loginState: state.loginState } : {}),
      ...(state.otpAttempts !== undefined
        ? { otpAttempts: state.otpAttempts }
        : {}),
      ...(state.otpMaxAttempts !== undefined
        ? { otpMaxAttempts: state.otpMaxAttempts }
        : {}),
      otpRequired: state.loginState === 'otp_required',
    };
  }

  private mcpImageDataUrl(image?: McpContent) {
    if (!image?.data) {
      return undefined;
    }
    const mimeType = image.mimeType || 'image/png';
    if (!['image/png', 'image/jpeg'].includes(mimeType)) {
      throw new Error(`RedNote MCP returned unsupported ${mimeType} data.`);
    }
    const base64 = image.data.replace(/\s/g, '');
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
      Buffer.from(base64, 'base64').byteLength > MAX_QR_CODE_BYTES
    ) {
      throw new Error('RedNote MCP returned an invalid QR code image.');
    }
    return `data:${mimeType};base64,${base64}`;
  }

  async getInteractiveLoginStatus(key: string) {
    const state = interactiveLogins.get(key) || {
      status: 'idle' as const,
      message: 'Request a RedNote QR code to authenticate an account.',
    };
    if (state.status !== 'running') {
      return this.loginStatusResponse(state);
    }

    if (!state.statusCheck) {
      state.statusCheck = this.updateInteractiveLoginStatus(key, state).finally(
        () => {
          state.statusCheck = undefined;
        }
      );
    }
    await state.statusCheck;
    return this.loginStatusResponse(state);
  }

  private async updateInteractiveLoginStatus(
    key: string,
    state: InteractiveLogin
  ) {
    if (!state.credentials || !state.loginSessionId) {
      state.status = 'error';
      state.message = 'The RedNote login session is missing its configuration.';
      return;
    }

    try {
      const result = await this.callMcpToolResult(
        state.credentials,
        'get_login_session_status',
        { session_id: state.loginSessionId },
        60_000
      );
      const output = result.text;
      if (state.cancelled || interactiveLogins.get(key) !== state) {
        return;
      }
      const session = this.parseLoginSessionStatus(output);
      state.loginState = session.loginState;
      state.otpAttempts = session.otpAttempts;
      state.otpMaxAttempts = session.otpMaxAttempts;

      if (session.loginState === 'authenticated') {
        if (state.cookiePath) {
          await access(state.cookiePath);
          if (process.platform !== 'win32') {
            await chmod(state.cookiePath, 0o600);
          }
        }
        const username =
          output.match(/用户名[:：]\s*([^\n]+)/)?.[1]?.trim() || 'RedNote';
        state.status = 'success';
        state.message = `Authenticated as ${username}. The login cookie was saved.`;
        state.qrCode = undefined;
        state.expiresAt = undefined;
        if (state.backupCookiePath) {
          await rm(state.backupCookiePath, { force: true });
        }
        if (activeInteractiveLoginKey === key) {
          activeInteractiveLoginKey = undefined;
        }
        return;
      }

      if (session.loginState === 'captcha_required') {
        const challengeImage = result.content.find(
          (item) => item.type === 'image' && item.data
        );
        const challengeQrCode = this.mcpImageDataUrl(challengeImage);
        if (!challengeQrCode) {
          state.status = 'error';
          state.message =
            'Xiaohongshu requested a second security QR, but the installed MCP binary did not return its image. Update the binary and try again.';
          state.qrCode = undefined;
          return;
        }
        state.qrCode = challengeQrCode;
        state.message =
          'Scan this account-security QR with the already signed-in Xiaohongshu app, then approve the login. Postiz refreshed it in the same browser session.';
        return;
      }

      const messages: Record<RedNoteLoginState, string> = {
        waiting_for_scan:
          'Scan the QR code with the Xiaohongshu app to continue.',
        qr_scanned: 'QR code scanned. Waiting for Xiaohongshu confirmation…',
        otp_required:
          'Xiaohongshu requires a six-digit verification code. Enter it below.',
        submitting_otp: 'Submitting the verification code securely…',
        otp_submitted:
          'Verification code submitted. Waiting for Xiaohongshu to finish login…',
        captcha_required:
          'Scan the account-security QR code below with the Xiaohongshu app.',
        authenticated: 'RedNote login completed.',
        failed: session.lastError
          ? `RedNote login failed: ${session.lastError}`
          : 'RedNote login failed. Request a new QR code.',
        expired: 'This QR code expired. Request a new one and scan it again.',
        cancelled:
          'This login session was replaced. Request a new QR code and try again.',
      };
      state.message = messages[session.loginState];

      if (['failed', 'expired', 'cancelled'].includes(session.loginState)) {
        state.status = 'error';
        state.qrCode = undefined;
        if (
          state.hasCookieBackup &&
          state.backupCookiePath &&
          state.cookiePath
        ) {
          await copyFile(state.backupCookiePath, state.cookiePath).catch(
            () => undefined
          );
        }
        if (activeInteractiveLoginKey === key) {
          activeInteractiveLoginKey = undefined;
        }
      }
    } catch (error) {
      if (state.cancelled || interactiveLogins.get(key) !== state) {
        return;
      }
      state.message =
        error instanceof Error
          ? `Waiting for approval (${error.message})`
          : 'Waiting for approval in the Xiaohongshu app.';
    }

    if (state.expiresAt && Date.now() >= state.expiresAt) {
      state.status = 'error';
      state.message =
        'This QR code expired. Request a new one and scan it again.';
      state.qrCode = undefined;
      if (state.hasCookieBackup && state.backupCookiePath && state.cookiePath) {
        await copyFile(state.backupCookiePath, state.cookiePath).catch(
          () => undefined
        );
      }
      if (activeInteractiveLoginKey === key) {
        activeInteractiveLoginKey = undefined;
      }
    }
  }

  private parseLoginSessionStatus(output: string) {
    const states: Array<[RegExp, RedNoteLoginState]> = [
      [/需要输入验证码|OTP required/i, 'otp_required'],
      [/正在提交验证码|submitting OTP/i, 'submitting_otp'],
      [/验证码已提交|OTP submitted/i, 'otp_submitted'],
      [/需要人工完成 CAPTCHA|CAPTCHA required/i, 'captcha_required'],
      [/登录成功|authenticated/i, 'authenticated'],
      [/二维码已扫描|QR code scanned/i, 'qr_scanned'],
      [/登录会话已过期|session expired/i, 'expired'],
      [/登录会话已被新的二维码取代|session cancelled/i, 'cancelled'],
      [/登录失败|login failed/i, 'failed'],
      [/等待扫码|waiting for scan/i, 'waiting_for_scan'],
    ];
    const loginState = states.find(([pattern]) => pattern.test(output))?.[1];
    if (!loginState) {
      throw new Error('RedNote MCP returned an unknown login session state.');
    }

    const attempts = output.match(
      /验证码提交次数\s*[:：]\s*(\d+)\s*\/\s*(\d+)/i
    );
    const lastError = output.match(/页面提示\s*[:：]\s*([^\n]+)/i)?.[1]?.trim();
    return {
      loginState,
      otpAttempts: attempts ? Number(attempts[1]) : 0,
      otpMaxAttempts: attempts ? Number(attempts[2]) : 3,
      lastError,
    };
  }

  async submitInteractiveLoginCode(key: string, code: string) {
    if (!OTP_CODE_PATTERN.test(code)) {
      throw new Error('Verification code must contain exactly six digits.');
    }
    const state = interactiveLogins.get(key);
    if (
      !state ||
      state.status !== 'running' ||
      !state.credentials ||
      !state.loginSessionId
    ) {
      throw new Error('The RedNote login session is no longer active.');
    }
    if (state.loginState !== 'otp_required') {
      throw new Error(
        'Xiaohongshu is not currently requesting a verification code.'
      );
    }
    if (state.otpSubmission) {
      throw new Error('A verification code is already being submitted.');
    }

    state.loginState = 'submitting_otp';
    state.message = 'Submitting the verification code securely…';
    state.otpSubmission = this.callMcpTool(
      state.credentials,
      'submit_login_code',
      { session_id: state.loginSessionId, code },
      60_000
    )
      .then(() => {
        state.loginState = 'otp_submitted';
        state.message =
          'Verification code submitted. Waiting for Xiaohongshu to finish login…';
      })
      .catch((error) => {
        state.loginState = 'otp_required';
        state.message =
          error instanceof Error
            ? error.message
            : 'Unable to submit the verification code.';
        throw error;
      })
      .finally(() => {
        state.otpSubmission = undefined;
      });

    await state.otpSubmission;
    return this.loginStatusResponse(state);
  }

  async startMcpForSetup(value?: Partial<RedNoteCredentials>) {
    const credentials = this.setupCredentials(value);
    const output = await this.callMcpTool(
      credentials,
      'check_login_status',
      {},
      90_000
    );
    if (/未登录|not logged in/i.test(output)) {
      throw new Error(
        'The MCP server could not use the saved RedNote cookie. Run Step 1 again.'
      );
    }

    const username =
      output.match(/用户名[:：]\s*([^\n]+)/)?.[1]?.trim() ||
      credentials.profileName;
    return {
      success: true,
      username,
      message: `MCP is running and authenticated as ${username}.`,
    };
  }

  private validateEndpoint(endpoint: string) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('RedNote MCP endpoint must be a valid URL.');
    }

    const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
    if (url.protocol !== 'http:' || !localHosts.has(url.hostname)) {
      throw new Error(
        'RedNote MCP endpoint must use HTTP on localhost for this local binary integration.'
      );
    }

    if (url.pathname !== '/mcp') {
      throw new Error('RedNote MCP endpoint must end with /mcp.');
    }

    return url;
  }

  private async requestMcp(
    endpoint: string,
    body: Record<string, unknown>,
    sessionId?: string,
    timeoutMs = 30_000
  ): Promise<{ envelope?: McpEnvelope; sessionId?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `RedNote MCP returned HTTP ${
            response.status
          }: ${await response.text()}`
        );
      }

      const returnedSessionId =
        response.headers.get('mcp-session-id') || sessionId || undefined;
      const raw = await response.text();
      if (!raw.trim()) {
        return { sessionId: returnedSessionId };
      }

      const contentType = response.headers.get('content-type') || '';
      const payload = contentType.includes('text/event-stream')
        ? raw
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .filter(Boolean)
            .at(-1)
        : raw;

      if (!payload) {
        return { sessionId: returnedSessionId };
      }

      return {
        envelope: JSON.parse(payload) as McpEnvelope,
        sessionId: returnedSessionId,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`RedNote MCP request timed out after ${timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async openMcpSession(endpoint: string, timeoutMs = 30_000) {
    const initialized = await this.requestMcp(
      endpoint,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'Postiz', version: '1.0.0' },
        },
      },
      undefined,
      timeoutMs
    );

    if (initialized.envelope?.error) {
      throw new Error(
        initialized.envelope.error.message ||
          'RedNote MCP initialization failed.'
      );
    }
    if (!initialized.sessionId) {
      throw new Error('RedNote MCP did not return a session ID.');
    }

    await this.requestMcp(
      endpoint,
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      },
      initialized.sessionId,
      timeoutMs
    );

    return initialized.sessionId;
  }

  private async closeMcpSession(endpoint: string, sessionId: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      await fetch(endpoint, {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': sessionId },
        signal: controller.signal,
      });
    } catch {
      // Session cleanup is best-effort and must not hide the tool result.
    } finally {
      clearTimeout(timer);
    }
  }

  private async probeMcp(endpoint: string, timeoutMs = 4_000) {
    const sessionId = await this.openMcpSession(endpoint, timeoutMs);
    await this.closeMcpSession(endpoint, sessionId);
  }

  private async startMcpServer(credentials: RedNoteCredentials) {
    const endpoint = this.validateEndpoint(credentials.mcpEndpoint);
    if (!isAbsolute(credentials.binaryPath)) {
      throw new Error('RedNote MCP binary path must be absolute.');
    }
    const paths = await ensureRedNoteBinaries(credentials.binaryPath);

    const port = endpoint.port || '80';
    const child = spawn(
      paths.mcpPath,
      ['-headless=true', '-port', `:${port}`],
      {
        cwd: paths.installDirectory,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, COOKIES_PATH: paths.cookiePath },
      }
    );
    child.once('error', () => undefined);
    child.unref();

    let lastError: unknown;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        await this.probeMcp(credentials.mcpEndpoint, 4_000);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    throw new Error(
      `RedNote MCP server did not become ready: ${
        lastError instanceof Error ? lastError.message : 'unknown startup error'
      }`
    );
  }

  private async ensureMcpServer(credentials: RedNoteCredentials) {
    this.validateEndpoint(credentials.mcpEndpoint);
    try {
      await this.probeMcp(credentials.mcpEndpoint);
      return;
    } catch {
      // Start the configured local binary below.
    }

    const existing = startingServers.get(credentials.mcpEndpoint);
    if (existing) {
      return existing;
    }

    const starting = this.startMcpServer(credentials).finally(() => {
      startingServers.delete(credentials.mcpEndpoint);
    });
    startingServers.set(credentials.mcpEndpoint, starting);
    return starting;
  }

  protected async callMcpToolResult(
    credentials: RedNoteCredentials,
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 120_000
  ): Promise<McpToolResult> {
    await this.ensureMcpServer(credentials);
    const sessionId = await this.openMcpSession(credentials.mcpEndpoint);

    try {
      const response = await this.requestMcp(
        credentials.mcpEndpoint,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name, arguments: args },
        },
        sessionId,
        timeoutMs
      );

      if (response.envelope?.error) {
        throw new Error(
          response.envelope.error.message || `RedNote MCP tool ${name} failed.`
        );
      }

      const result = response.envelope?.result;
      const text =
        result?.content
          ?.filter((item) => item.type === 'text' && item.text)
          .map((item) => item.text)
          .join('\n') || '';

      if (result?.isError) {
        throw new Error(text || `RedNote MCP tool ${name} failed.`);
      }

      return { content: result?.content || [], text };
    } finally {
      await this.closeMcpSession(credentials.mcpEndpoint, sessionId);
    }
  }

  protected async callMcpTool(
    credentials: RedNoteCredentials,
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 120_000
  ) {
    return (await this.callMcpToolResult(credentials, name, args, timeoutMs))
      .text;
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }): Promise<AuthTokenDetails | string> {
    try {
      const credentials = this.decodeCredentials(params.code);
      const output = await this.callMcpTool(
        credentials,
        'check_login_status',
        {},
        90_000
      );

      if (/未登录|not logged in/i.test(output)) {
        return 'RedNote binary session is not logged in.';
      }

      const username =
        output.match(/用户名[:：]\s*([^\n]+)/)?.[1]?.trim() ||
        credentials.profileName;
      const id = createHash('sha256')
        .update(`${credentials.binaryPath}\0${credentials.mcpEndpoint}`)
        .digest('hex')
        .slice(0, 24);

      return {
        id,
        name: credentials.profileName,
        accessToken: params.code,
        refreshToken: params.code,
        expiresIn: 60 * 60 * 24 * 365 * 100,
        picture: '',
        username,
      };
    } catch (error) {
      return error instanceof Error
        ? error.message
        : 'RedNote login check failed.';
    }
  }

  private firstItem(post: PostDetails<RedNoteDto>[]) {
    return post[0]?.settings;
  }

  private sessionIsLoggedOut(output: string) {
    return /未登录|登录(?:状态)?(?:已)?过期|not logged in|login required|session expired/i.test(
      output
    );
  }

  protected async assertAuthenticatedSession(credentials: RedNoteCredentials) {
    let output: string;
    try {
      output = await this.callMcpTool(
        credentials,
        'check_login_status',
        {},
        SESSION_PREFLIGHT_TIMEOUT_MS
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.sessionIsLoggedOut(message)) {
        throw new Disconnect(
          this.identifier,
          JSON.stringify({ reason: 'session_expired' }),
          '{}',
          SESSION_EXPIRED_MESSAGE
        );
      }
      throw error;
    }

    if (this.sessionIsLoggedOut(output)) {
      throw new Disconnect(
        this.identifier,
        JSON.stringify({ reason: 'session_expired' }),
        '{}',
        SESSION_EXPIRED_MESSAGE
      );
    }
  }

  private validateTitle(title: string) {
    const units = Array.from(title).reduce(
      (sum, character) => sum + (/^[\x00-\xff]$/.test(character) ? 0.5 : 1),
      0
    );
    if (units > 20) {
      throw new Error(
        `RedNote title is ${units} units; the platform limit is 20 Chinese-character units.`
      );
    }
  }

  protected async existingLocalPath(relativePath: string) {
    const normalized = relativePath.replace(/^\/+/, '');
    const candidates = [
      join(process.cwd(), normalized),
      join(process.cwd(), '..', '..', normalized),
    ];

    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next Postiz working-directory layout.
      }
    }
    return undefined;
  }

  protected async localOrPublicMediaPath(value: string) {
    if (isAbsolute(value)) {
      return value;
    }

    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
          return (await this.existingLocalPath(url.pathname)) || value;
        }
      } catch {
        return value;
      }
      return value;
    }

    return (await this.existingLocalPath(value)) || value;
  }

  private async materializeVideo(value: string, directory: string) {
    const outputPath = join(
      directory,
      basename(new URL(value, 'file:///').pathname)
    );
    const source = await this.localOrPublicMediaPath(value);

    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(
          `Unable to download RedNote video: HTTP ${response.status}`
        );
      }
      await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    } else {
      await copyFile(source, outputPath);
    }
    return outputPath;
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<RedNoteDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const settings = this.firstItem(postDetails);
    if (!settings) {
      throw new Error('RedNote settings are missing.');
    }

    const title = settings.title?.trim() || postDetails[0]?.message?.trim();
    if (!title) {
      throw new Error('RedNote requires a title.');
    }
    this.validateTitle(title);

    const content = postDetails[0]?.message?.trim();
    if (!content) {
      throw new Error('RedNote requires post content.');
    }

    const credentials = this.decodeCredentials(accessToken);
    await this.assertAuthenticatedSession(credentials);
    const media = postDetails.flatMap((item) => item.media || []);
    const video = media.find(
      (item) => item.type === 'video' || /\.mp4(?:$|\?)/i.test(item.path)
    );
    const images = media.filter((item) => item !== video);
    const tags =
      settings.tags
        ?.split(',')
        .map((tag) => tag.trim())
        .filter(Boolean) || [];
    let output = '';

    if (video) {
      const directory = await mkdtemp(join(tmpdir(), 'postiz-rednote-'));
      try {
        const videoPath = await this.materializeVideo(video.path, directory);
        output = await this.callMcpTool(
          credentials,
          'publish_with_video',
          {
            title,
            content,
            video: videoPath,
            tags,
            visibility: settings.visibility || '公开可见',
          },
          15 * 60_000
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    } else {
      if (!images.length) {
        throw new Error('RedNote image posts require at least one image.');
      }
      const imagePaths = await Promise.all(
        images.map((item) => this.localOrPublicMediaPath(item.path))
      );
      output = await this.callMcpTool(
        credentials,
        'publish_content',
        {
          title,
          content,
          images: imagePaths,
          tags,
          is_original: settings.original ?? true,
          visibility: settings.visibility || '公开可见',
        },
        15 * 60_000
      );
    }

    const remoteId =
      output.match(
        /(?:noteId|note_id|笔记ID|ID)\s*[:=：]\s*([a-f0-9]{24})/i
      )?.[1] || postDetails[0]?.id;

    return postDetails.map((item) => ({
      id: item.id,
      postId: remoteId || item.id,
      releaseURL: 'https://creator.xiaohongshu.com/publish/publish',
      status: 'completed',
    }));
  }

  async customFields() {
    return [
      {
        key: 'mcpEndpoint',
        label: 'Local MCP endpoint',
        type: 'text' as const,
        validation: '/.+/',
        defaultValue: process.env.XHS_MCP_ENDPOINT || DEFAULT_MCP_ENDPOINT,
        hint: 'Local Streamable HTTP endpoint. The provider rejects non-local URLs.',
      },
      {
        key: 'profileName',
        label: 'Account label',
        type: 'text' as const,
        validation: '/.+/',
        defaultValue: 'RedNote Binary Account',
      },
    ];
  }
}
