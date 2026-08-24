import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const RELEASE_REPOSITORY = 'xpzouying/xiaohongshu-mcp';
export const DEFAULT_REDNOTE_RELEASE = 'v2.5.0';

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
  releaseTag: string;
};

const installing = new Map<string, Promise<RedNoteBinaryPaths>>();

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
  binaryOverride?: string
): RedNoteBinaryPaths => {
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

  return {
    cookiePath: resolve(
      process.env.XHS_COOKIES_PATH || join(redNoteDataDirectory, 'cookies.json')
    ),
    dataDirectory: redNoteDataDirectory,
    installDirectory,
    loginPath: resolve(
      process.env.XHS_LOGIN_BINARY || join(installDirectory, assets.login)
    ),
    mcpPath,
    platformLabel: assets.label,
    releaseTag,
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
  await migrateLegacyCookie(paths);
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
  binaryOverride?: string
): Promise<RedNoteBinaryPaths> => {
  const paths = redNoteBinaryPaths(binaryOverride);
  const key = `${paths.mcpPath}\0${paths.loginPath}`;
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
