import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RedNoteProvider } from './rednote.provider';
import { Disconnect } from '../social.abstract';
import { redNoteBinaryPaths } from './rednote.binary.installer';

const credentials = Buffer.from(
  JSON.stringify({
    binaryPath: '/tmp/xiaohongshu-mcp',
    mcpEndpoint: 'http://127.0.0.1:18060/mcp',
    profileName: 'RedNote test account',
  })
).toString('base64url');

const postDetails = [
  {
    id: 'post-1',
    message: 'Post body',
    settings: { title: 'Test title', visibility: '仅自己可见' },
    media: [{ id: 'media-1', path: 'https://example.com/image.jpg' }],
  },
] as any;

test('RedNote publish stops before media handling when the session expired', async () => {
  const provider = new RedNoteProvider();
  const calls: string[] = [];
  (provider as any).callMcpTool = async (_credentials: unknown, name: string) => {
    calls.push(name);
    return '❌ 未登录\n\n请重新登录。';
  };

  await assert.rejects(
    () => provider.post('integration-1', credentials, postDetails, {} as any),
    (error: unknown) => {
      assert.ok(error instanceof Disconnect);
      assert.match(error.message, /session has expired/i);
      return true;
    }
  );

  assert.deepEqual(calls, ['check_login_status']);
});

test('RedNote publish checks the session before invoking the publish tool', async () => {
  const provider = new RedNoteProvider();
  const calls: Array<{
    name: string;
    args: Record<string, unknown>;
    timeout: number;
  }> = [];
  (provider as any).callMcpTool = async (
    _credentials: unknown,
    name: string,
    args: Record<string, unknown>,
    timeout: number
  ) => {
    calls.push({ name, args, timeout });
    return name === 'check_login_status' ? '✅ 已登录' : '发布完成';
  };

  await provider.post('integration-1', credentials, postDetails, {} as any);

  assert.equal(calls[0]?.name, 'check_login_status');
  assert.equal(calls[0]?.timeout, 45_000);
  assert.equal(calls[1]?.name, 'publish_content');
  assert.deepEqual(calls[1]?.args.images, ['https://example.com/image.jpg']);
});

test('RedNote publish routes MOV attachments to the video publisher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'postiz-rednote-video-'));
  const videoPath = join(directory, 'IMG_4254.MOV');

  try {
    await writeFile(videoPath, 'video');
    const provider = new RedNoteProvider();
    const calls: Array<{
      name: string;
      args: Record<string, unknown>;
    }> = [];
    (provider as any).callMcpTool = async (
      _credentials: unknown,
      name: string,
      args: Record<string, unknown>
    ) => {
      calls.push({ name, args });
      return name === 'check_login_status' ? '✅ 已登录' : '发布完成';
    };

    await provider.post(
      'integration-1',
      credentials,
      [
        {
          id: 'post-1',
          message: 'Post body',
          settings: { title: 'Test title', visibility: '仅自己可见' },
          media: [{ id: 'media-1', path: videoPath }],
        },
      ] as any,
      {} as any
    );

    assert.equal(calls[0]?.name, 'check_login_status');
    assert.equal(calls[1]?.name, 'publish_with_video');
    assert.match(String(calls[1]?.args.video), /IMG_4254\.MOV$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('RedNote publish converts an explicit expired-session tool error to a disconnect', async () => {
  const provider = new RedNoteProvider();
  (provider as any).callMcpTool = async () => {
    throw new Error('RedNote MCP: session expired; login required');
  };

  await assert.rejects(
    () => provider.post('integration-1', credentials, postDetails, {} as any),
    (error: unknown) => {
      assert.ok(error instanceof Disconnect);
      assert.match(error.message, /Reconnect the RedNote channel/i);
      return true;
    }
  );
});

test('RedNote resolves only same-origin Postiz upload URLs to local files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'postiz-rednote-upload-'));
  const nestedDirectory = join(directory, '2026', '09', '05');
  const imagePath = join(nestedDirectory, 'cover.png');
  const previousUploadDirectory = process.env.UPLOAD_DIRECTORY;
  const previousFrontendUrl = process.env.FRONTEND_URL;

  try {
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(imagePath, 'image');
    process.env.UPLOAD_DIRECTORY = directory;
    process.env.FRONTEND_URL = 'https://post.example.test';

    const provider = new RedNoteProvider();
    assert.equal(
      await (provider as any).localOrPublicMediaPath(
        'https://post.example.test/uploads/2026/09/05/cover.png'
      ),
      imagePath
    );
    assert.equal(
      await (provider as any).localOrPublicMediaPath(
        'https://elsewhere.example/uploads/2026/09/05/cover.png'
      ),
      'https://elsewhere.example/uploads/2026/09/05/cover.png'
    );
    assert.equal(
      await (provider as any).localOrPublicMediaPath(
        'https://post.example.test/uploads/%2e%2e/secret.png'
      ),
      'https://post.example.test/uploads/%2e%2e/secret.png'
    );
  } finally {
    if (previousUploadDirectory === undefined) {
      delete process.env.UPLOAD_DIRECTORY;
    } else {
      process.env.UPLOAD_DIRECTORY = previousUploadDirectory;
    }
    if (previousFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = previousFrontendUrl;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('RedNote assigns different persistent cookie profiles and MCP endpoints to different organizations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'postiz-rednote-profiles-'));
  const previousConfigDirectory = process.env.POSTIZ_CONFIG_DIR;
  const previousJwtSecret = process.env.JWT_SECRET;
  const previousPortMinimum = process.env.XHS_MCP_PROFILE_PORT_MIN;
  const previousPortMaximum = process.env.XHS_MCP_PROFILE_PORT_MAX;

  try {
    process.env.POSTIZ_CONFIG_DIR = directory;
    process.env.JWT_SECRET = 'rednote-profile-test-secret';
    process.env.XHS_MCP_PROFILE_PORT_MIN = '31000';
    process.env.XHS_MCP_PROFILE_PORT_MAX = '31010';
    const provider = new RedNoteProvider();

    const first = await (provider as any).setupIsolatedCredentials(
      'organization-a'
    );
    const second = await (provider as any).setupIsolatedCredentials(
      'organization-b'
    );
    const firstAgain = await (provider as any).setupIsolatedCredentials(
      'organization-a'
    );

    assert.notEqual(first.profileId, second.profileId);
    assert.notEqual(first.mcpEndpoint, second.mcpEndpoint);
    assert.equal(firstAgain.profileId, first.profileId);
    assert.equal(firstAgain.mcpEndpoint, first.mcpEndpoint);

    const firstPaths = redNoteBinaryPaths(first.binaryPath, first.profileId);
    const secondPaths = redNoteBinaryPaths(second.binaryPath, second.profileId);
    assert.notEqual(firstPaths.cookiePath, secondPaths.cookiePath);
    assert.match(
      firstPaths.cookiePath,
      /profiles[/\\][a-f0-9]{24}[/\\]cookies\.json$/
    );

    const encoded = Buffer.from(JSON.stringify(first), 'utf8').toString(
      'base64url'
    );
    assert.deepEqual((provider as any).decodeCredentials(encoded), first);

    const tampered = Buffer.from(
      JSON.stringify({ ...first, mcpEndpoint: second.mcpEndpoint }),
      'utf8'
    ).toString('base64url');
    assert.throws(
      () => (provider as any).decodeCredentials(tampered),
      /Invalid RedNote binary configuration/
    );

    const unsignedScopedEndpoint = Buffer.from(
      JSON.stringify({
        binaryPath: first.binaryPath,
        mcpEndpoint: first.mcpEndpoint,
        profileName: first.profileName,
      }),
      'utf8'
    ).toString('base64url');
    assert.throws(
      () => (provider as any).decodeCredentials(unsignedScopedEndpoint),
      /Invalid RedNote binary configuration/
    );
  } finally {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('POSTIZ_CONFIG_DIR', previousConfigDirectory);
    restore('JWT_SECRET', previousJwtSecret);
    restore('XHS_MCP_PROFILE_PORT_MIN', previousPortMinimum);
    restore('XHS_MCP_PROFILE_PORT_MAX', previousPortMaximum);
    await rm(directory, { recursive: true, force: true });
  }
});
