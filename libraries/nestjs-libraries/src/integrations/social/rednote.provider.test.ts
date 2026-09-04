import assert from 'node:assert/strict';
import test from 'node:test';
import { RedNoteProvider } from './rednote.provider';
import { Disconnect } from '../social.abstract';

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
