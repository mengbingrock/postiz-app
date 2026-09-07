import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const RELEASE_REPOSITORY = 'mengbingrock/xiaohongshu-mcp';
export const DEFAULT_REDNOTE_RELEASE = 'v2.10.1';

type PlatformAssets = {
  label: string;
  login: string;
  mcp: string;
};

type GithubReleaseAsset = {
  name: string;
  size: number;
  digest?: string;
  browser_download_url: string;
};

type GithubRelease = {
  tag_name: string;
  assets: GithubReleaseAsset[];
};

export type RedNoteBinaryPaths = {
  cookiePath: string;
  dataDirectory: string;
  installDirectory: string;
  loginPath: string;
  mcpPath: string;
  platformLabel: string;
  profileDirectory?: string;
  releaseTag: string;
};

const installing = new Map<string, Promise<RedNoteBinaryPaths>>();
const PROFILE_ID_PATTERN = /^[a-f0-9]{24}$/;
const MCP_PROFILE_PORT_FILE = 'mcp-port';
const CHINESEINLA_CDP_PORT_FILE = 'chineseinla-cdp-port';
const PROFILE_PORT_FILES = [MCP_PROFILE_PORT_FILE, CHINESEINLA_CDP_PORT_FILE];
const DEFAULT_PROFILE_PORT_MIN = 20_000;
const DEFAULT_PROFILE_PORT_MAX = 59_999;
let allocatingProfilePort: Promise<unknown> = Promise.resolve();

export const redNotePlatformAssets = (
  platform = process.platform,
  architecture = process.arch
): PlatformAssets => {
  const key = `${platform}-${architecture}`;
  const supported: Record<string, PlatformAssets> = {
    'darwin-arm64': {
      label: 'macOS Apple Silicon',
      mcp: 'xiaohongshu-mcp-darwin-arm64',
      login: 'xiaohongshu-login-darwin-arm64',
    },
    'win32-x64': {
      label: 'Windows x64',
      mcp: 'xiaohongshu-mcp-windows-amd64.exe',
      login: 'xiaohongshu-login-windows-amd64.exe',
    },
    'linux-x64': {
      label: 'Linux x64',
      mcp: 'xiaohongshu-mcp-linux-amd64',
      login: 'xiaohongshu-login-linux-amd64',
    },
  };

  const assets = supported[key];
  if (!assets) {
    throw new Error(
      `RedNote precompiled binaries do not support ${platform} ${architecture}. ` +
        'Supported platforms are macOS Apple Silicon, Windows x64, and Linux x64.'
    );
  }
  return assets;
};

export const redNoteBinaryPaths = (
  binaryOverride?: string,
  profileId?: string
): RedNoteBinaryPaths => {
  if (profileId && !PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error('Invalid RedNote profile identifier.');
  }
  const assets = redNotePlatformAssets();
  const releaseTag = process.env.XHS_MCP_VERSION || DEFAULT_REDNOTE_RELEASE;
  const postizConfigDirectory = resolve(
    process.env.POSTIZ_CONFIG_DIR || join(homedir(), '.postiz')
  );
  const redNoteDataDirectory = join(postizConfigDirectory, 'rednote');
  const defaultDirectory =
    process.env.XHS_MCP_INSTALL_DIR || join(redNoteDataDirectory, releaseTag);
  const mcpPath = resolve(
    binaryOverride ||
      process.env.XHS_MCP_BINARY ||
      join(defaultDirectory, assets.mcp)
  );
  const installDirectory = dirname(mcpPath);
  const profileDirectory = profileId
    ? join(redNoteDataDirectory, 'profiles', profileId)
    : undefined;

  return {
    cookiePath: resolve(
      profileDirectory
        ? join(profileDirectory, 'cookies.json')
        : process.env.XHS_COOKIES_PATH ||
            join(redNoteDataDirectory, 'cookies.json')
    ),
    dataDirectory: redNoteDataDirectory,
    installDirectory,
    loginPath: resolve(
      process.env.XHS_LOGIN_BINARY || join(installDirectory, assets.login)
    ),
    mcpPath,
    platformLabel: assets.label,
    profileDirectory,
    releaseTag,
  };
};

const configuredProfilePortRange = () => {
  const minimum = Number(
    process.env.XHS_MCP_PROFILE_PORT_MIN || DEFAULT_PROFILE_PORT_MIN
  );
  const maximum = Number(
    process.env.XHS_MCP_PROFILE_PORT_MAX || DEFAULT_PROFILE_PORT_MAX
  );
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 1024 ||
    maximum > 65535 ||
    maximum < minimum
  ) {
    throw new Error(
      'XHS_MCP_PROFILE_PORT_MIN and XHS_MCP_PROFILE_PORT_MAX must define a valid unprivileged TCP port range.'
    );
  }
  return { minimum, maximum };
};

const readProfilePort = async (path: string) => {
  try {
    const value = Number((await readFile(path, 'utf8')).trim());
    return Number.isInteger(value) ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const allocateRedNoteProfilePort = async (
  profileId: string,
  portFile: string
) => {
  const paths = redNoteBinaryPaths(undefined, profileId);
  const profileDirectory = paths.profileDirectory!;
  const portPath = join(profileDirectory, portFile);
  const { minimum, maximum } = configuredProfilePortRange();
  const existingPort = await readProfilePort(portPath);
  if (
    existingPort !== undefined &&
    existingPort >= minimum &&
    existingPort <= maximum
  ) {
    return existingPort;
  }

  const profilesDirectory = dirname(profileDirectory);
  await mkdir(profilesDirectory, { recursive: true, mode: 0o700 });
  const assignedPorts = new Set<number>();
  const profiles = await readdir(profilesDirectory, { withFileTypes: true });
  await Promise.all(
    profiles
      .filter((profile) => profile.isDirectory())
      .flatMap((profile) =>
        PROFILE_PORT_FILES.map(async (assignedPortFile) => {
          const port = await readProfilePort(
            join(profilesDirectory, profile.name, assignedPortFile)
          );
          if (port !== undefined) {
            assignedPorts.add(port);
          }
        })
      )
  );

  const portCount = maximum - minimum + 1;
  const preferredOffset =
    createHash('sha256')
      .update(`${profileId}\0${portFile}`)
      .digest()
      .readUInt32BE(0) % portCount;
  let selectedPort: number | undefined;
  for (let offset = 0; offset < portCount; offset += 1) {
    const candidate = minimum + ((preferredOffset + offset) % portCount);
    if (!assignedPorts.has(candidate)) {
      selectedPort = candidate;
      break;
    }
  }
  if (selectedPort === undefined) {
    throw new Error('No RedNote MCP profile ports are available.');
  }

  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await writeFile(portPath, `${selectedPort}\n`, { mode: 0o600 });
  return selectedPort;
};

const withProfilePortAllocation = async <T>(callback: () => Promise<T>) => {
  const allocation = allocatingProfilePort.then(callback);
  allocatingProfilePort = allocation.catch(() => undefined);
  return allocation;
};

const validateProfileId = (profileId: string) => {
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error('Invalid RedNote profile identifier.');
  }
};

export const redNoteProfileEndpoint = async (profileId: string) => {
  validateProfileId(profileId);
  const port = await withProfilePortAllocation(() =>
    allocateRedNoteProfilePort(profileId, MCP_PROFILE_PORT_FILE)
  );
  return `http://127.0.0.1:${port}/mcp`;
};

export const redNoteChineseInLAProfilePaths = async (profileId: string) => {
  validateProfileId(profileId);
  const paths = redNoteBinaryPaths(undefined, profileId);
  const root = join(paths.profileDirectory!, 'chineseinla');
  const cdpPort = await withProfilePortAllocation(() =>
    allocateRedNoteProfilePort(profileId, CHINESEINLA_CDP_PORT_FILE)
  );
  return {
    cdpPort,
    cookiePath: join(root, 'cookies.json'),
    previewPath: join(root, 'prepared-preview.png'),
    profileDirectory: join(root, 'profile'),
    statePath: join(root, 'prepared.json'),
  };
};

const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const migrateLegacyCookie = async (paths: RedNoteBinaryPaths) => {
  if (await exists(paths.cookiePath)) {
    return;
  }

  const candidates = new Set([join(paths.installDirectory, 'cookies.json')]);
  const legacyDataDirectories = new Set([
    paths.dataDirectory,
    join(homedir(), '.postiz', 'rednote'),
  ]);
  for (const dataDirectory of legacyDataDirectories) {
    try {
      const entries = await readdir(dataDirectory, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          candidates.add(join(dataDirectory, entry.name, 'cookies.json'));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const legacyCookies = (
    await Promise.all(
      [...candidates]
        .filter((candidate) => candidate !== paths.cookiePath)
        .map(async (candidate) => {
          try {
            return { candidate, modifiedAt: (await stat(candidate)).mtimeMs };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return undefined;
            }
            throw error;
          }
        })
    )
  )
    .filter((item) => item !== undefined)
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  for (const { candidate } of legacyCookies) {
    try {
      await copyFile(candidate, paths.cookiePath, constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') {
        await chmod(paths.cookiePath, 0o600);
      }
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        return;
      }
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }
};

const secureExecutables = async (paths: RedNoteBinaryPaths) => {
  if (process.platform === 'win32') {
    return;
  }
  await Promise.all([
    chmod(paths.mcpPath, 0o700),
    chmod(paths.loginPath, 0o700),
  ]);
};

const githubRelease = async (releaseTag: string) => {
  const releasePath =
    releaseTag === 'latest'
      ? 'latest'
      : `tags/${encodeURIComponent(releaseTag)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(
      `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/${releasePath}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Postiz-RedNote-Installer',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      }
    );
    if (!response.ok) {
      throw new Error(
        `GitHub release metadata returned HTTP ${response.status}.`
      );
    }
    return (await response.json()) as GithubRelease;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Timed out while checking the RedNote binary release.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const validateAssetUrl = (value: string) => {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    !url.pathname.startsWith(`/${RELEASE_REPOSITORY}/releases/download/`)
  ) {
    throw new Error('GitHub returned an unexpected RedNote asset URL.');
  }
};

const downloadAsset = async (
  asset: GithubReleaseAsset,
  destination: string
) => {
  if (!asset.digest?.startsWith('sha256:')) {
    throw new Error(
      `GitHub did not publish a SHA-256 digest for ${asset.name}.`
    );
  }
  validateAssetUrl(asset.browser_download_url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60_000);
  const temporaryPath = `${destination}.download-${
    process.pid
  }-${randomUUID()}`;
  try {
    const response = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'Postiz-RedNote-Installer' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `${asset.name} download returned HTTP ${response.status}.`
      );
    }

    const contents = Buffer.from(await response.arrayBuffer());
    if (contents.byteLength !== asset.size) {
      throw new Error(
        `${asset.name} size mismatch: expected ${asset.size}, received ${contents.byteLength}.`
      );
    }
    const actualDigest = createHash('sha256').update(contents).digest('hex');
    const expectedDigest = asset.digest.slice('sha256:'.length).toLowerCase();
    if (actualDigest !== expectedDigest) {
      throw new Error(`SHA-256 verification failed for ${asset.name}.`);
    }

    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, contents, { mode: 0o700 });
    if (process.platform !== 'win32') {
      await chmod(temporaryPath, 0o700);
    }
    await rename(temporaryPath, destination);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timed out while downloading ${asset.name}.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const installMissingBinaries = async (paths: RedNoteBinaryPaths) => {
  const assets = redNotePlatformAssets();
  await mkdir(dirname(paths.cookiePath), { recursive: true, mode: 0o700 });
  if (!paths.profileDirectory) {
    await migrateLegacyCookie(paths);
  }
  const [hasMcp, hasLogin] = await Promise.all([
    exists(paths.mcpPath),
    exists(paths.loginPath),
  ]);
  if (hasMcp && hasLogin) {
    await secureExecutables(paths);
    return paths;
  }

  const release = await githubRelease(paths.releaseTag);
  const requested = [
    { installed: hasMcp, name: assets.mcp, path: paths.mcpPath },
    { installed: hasLogin, name: assets.login, path: paths.loginPath },
  ];

  for (const item of requested) {
    if (item.installed) {
      continue;
    }
    const asset = release.assets.find(
      (candidate) => candidate.name === item.name
    );
    if (!asset) {
      throw new Error(
        `Release ${release.tag_name} does not contain ${item.name} for ${paths.platformLabel}.`
      );
    }
    await downloadAsset(asset, item.path);
  }

  await secureExecutables(paths);
  return { ...paths, releaseTag: release.tag_name };
};

export const ensureRedNoteBinaries = async (
  binaryOverride?: string,
  profileId?: string
): Promise<RedNoteBinaryPaths> => {
  const paths = redNoteBinaryPaths(binaryOverride, profileId);
  const key = `${paths.mcpPath}\0${paths.loginPath}\0${paths.cookiePath}`;
  const active = installing.get(key);
  if (active) {
    return active;
  }

  const installation = installMissingBinaries(paths).finally(() => {
    installing.delete(key);
  });
  installing.set(key, installation);
  return installation;
};

export type RedNoteSite = 'cn' | 'intl';

const RED_NOTE_CREATOR_HOSTS: Record<RedNoteSite, string> = {
  cn: 'https://creator.xiaohongshu.com',
  intl: 'https://creator.rednote.com',
};

/**
 * Which Xiaohongshu property a profile's session belongs to. The MCP stamps
 * "site" on the session file after each scan; older files are classified from
 * their cookies (an id_token on rednote.com means the international brand).
 * Anything unreadable is treated as the domestic site.
 */
export const resolveRedNoteSite = async (
  cookiePath: string | undefined
): Promise<RedNoteSite> => {
  if (!cookiePath) {
    return 'cn';
  }
  try {
    const parsed = JSON.parse(await readFile(cookiePath, 'utf8'));
    if (parsed?.site === 'intl' || parsed?.site === 'cn') {
      return parsed.site;
    }
    const cookies: Array<{ name?: string; domain?: string }> = Array.isArray(
      parsed
    )
      ? parsed
      : Array.isArray(parsed?.cookies)
        ? parsed.cookies
        : [];
    return cookies.some(
      (c) => c?.name === 'id_token' && (c?.domain || '').includes('rednote.com')
    )
      ? 'intl'
      : 'cn';
  } catch {
    return 'cn';
  }
};

export const redNoteCreatorPublishURL = (site: RedNoteSite): string =>
  `${RED_NOTE_CREATOR_HOSTS[site]}/publish/publish`;
