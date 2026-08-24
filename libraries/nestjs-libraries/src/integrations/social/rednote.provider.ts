import { spawn, type ChildProcess } from 'node:child_process';
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
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { RedNoteDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/rednote.dto';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { Integration } from '@prisma/client';
import { createHash } from 'node:crypto';

type RedNoteCredentials = {
  binaryPath: string;
  mcpEndpoint: string;
  profileName: string;
};

type McpEnvelope = {
  jsonrpc?: string;
  id?: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code?: number; message?: string; data?: unknown };
};

const DEFAULT_BINARY_PATH = resolve(
  process.cwd(),
  '../../..',
  'xiaohongshu-mcp-bin/v2.5.0/xiaohongshu-mcp-darwin-arm64'
);
const DEFAULT_MCP_ENDPOINT = 'http://127.0.0.1:18060/mcp';
const DEFAULT_LOGIN_FILENAME = 'xiaohongshu-login-darwin-arm64';
const startingServers = new Map<string, Promise<void>>();
type InteractiveLogin = {
  status: 'idle' | 'running' | 'success' | 'error';
  message: string;
  child?: ChildProcess;
};
const interactiveLogins = new Map<string, InteractiveLogin>();

export class RedNoteProvider extends SocialAbstract implements SocialProvider {
  identifier = 'rednote';
  name = 'RedNote';
  isBetweenSteps = false;
  scopes: string[] = [];
  editor = 'normal' as const;
  dto = RedNoteDto;
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

  private decodeCredentials(value: string): RedNoteCredentials {
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
          DEFAULT_BINARY_PATH,
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

  private setupCredentials(
    value?: Partial<RedNoteCredentials>
  ): RedNoteCredentials {
    const configuredBinary =
      process.env.XHS_MCP_BINARY || DEFAULT_BINARY_PATH;
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
    const current = interactiveLogins.get(key);
    if (current?.status === 'running' && current.child?.exitCode === null) {
      return this.getInteractiveLoginStatus(key);
    }

    const credentials = this.setupCredentials(value);
    const workingDirectory = dirname(credentials.binaryPath);
    const loginPath =
      process.env.XHS_LOGIN_BINARY ||
      join(workingDirectory, DEFAULT_LOGIN_FILENAME);
    await access(credentials.binaryPath);
    await access(loginPath);

    // Force the upstream login utility to present a fresh sign-in instead of
    // silently reusing the previous account. Keep a recoverable copy in case
    // the user closes the window before authentication completes.
    const cookiePath = join(workingDirectory, 'cookies.json');
    const backupCookiePath = join(
      workingDirectory,
      'cookies.postiz-backup.json'
    );
    let hasCookieBackup = false;
    try {
      await copyFile(cookiePath, backupCookiePath);
      hasCookieBackup = true;
    } catch {
      // A first-time connection has no existing cookie to preserve.
    }
    await rm(cookiePath, { force: true });

    const child = spawn(loginPath, [], {
      cwd: workingDirectory,
      detached: false,
      stdio: 'ignore',
      windowsHide: false,
    });
    interactiveLogins.set(key, {
      status: 'running',
      message: 'Complete the login in the RedNote browser window.',
      child,
    });

    child.once('error', (error) => {
      interactiveLogins.set(key, {
        status: 'error',
        message: `Unable to open RedNote login: ${error.message}`,
      });
      if (hasCookieBackup) {
        copyFile(backupCookiePath, cookiePath).catch(() => undefined);
      }
    });
    child.once('exit', (code, signal) => {
      if (code === 0) {
        chmod(cookiePath, 0o600).catch(() => undefined);
        interactiveLogins.set(key, {
          status: 'success',
          message: 'Login cookie saved. You can now start MCP.',
        });
        return;
      }
      interactiveLogins.set(key, {
        status: 'error',
        message: `RedNote login closed before completing${
          signal ? ` (${signal})` : ''
        }.`,
      });
      if (hasCookieBackup) {
        copyFile(backupCookiePath, cookiePath).catch(() => undefined);
      }
    });

    return this.getInteractiveLoginStatus(key);
  }

  getInteractiveLoginStatus(key: string) {
    const state = interactiveLogins.get(key) || {
      status: 'idle' as const,
      message: 'Start the RedNote login to authenticate an account.',
    };
    return { status: state.status, message: state.message };
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
    await access(credentials.binaryPath);

    const port = endpoint.port || '80';
    const child = spawn(
      credentials.binaryPath,
      ['-headless=true', '-port', `:${port}`],
      {
        cwd: dirname(credentials.binaryPath),
        detached: true,
        stdio: 'ignore',
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

  private async callMcpTool(
    credentials: RedNoteCredentials,
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 120_000
  ) {
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

      return text;
    } finally {
      await this.closeMcpSession(credentials.mcpEndpoint, sessionId);
    }
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

  private async existingLocalPath(relativePath: string) {
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

  private async localOrPublicMediaPath(value: string) {
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
        key: 'binaryPath',
        label: 'Xiaohongshu MCP binary path',
        type: 'text' as const,
        validation: '/.+/',
        defaultValue: process.env.XHS_MCP_BINARY || DEFAULT_BINARY_PATH,
        hint: 'Absolute path to the verified precompiled MCP service binary.',
      },
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
