import assert from 'node:assert/strict';
import test from 'node:test';
import { ChineseInLAProvider } from './chineseinla.provider';
import { BadBody } from '../social.abstract';

const credentials = Buffer.from(
  JSON.stringify({
    binaryPath: '/tmp/xiaohongshu-mcp',
    mcpEndpoint: 'http://127.0.0.1:18060/mcp',
    profileName: 'ChineseInLA test account',
  })
).toString('base64url');

test('ChineseInLA preserves the first publish failure as a terminal bad-body error', async () => {
  const provider = new ChineseInLAProvider();
  let calls = 0;
  (provider as any).callMcpTool = async () => {
    calls += 1;
    throw new Error(
      "ChineseInLA blocked this server's network provider during submission"
    );
  };

  await assert.rejects(
    () =>
      provider.post(
        'integration-1',
        credentials,
        [
          {
            id: 'post-1',
            message: 'Body',
            settings: {
              forumId: 23,
              postType: 'other',
              title: 'Title',
              preparedDraftId: '09043c9c1548a44585f99f14efb3ec6b',
            },
            media: [],
          },
        ] as any,
        {} as any
      ),
    (error: unknown) => {
      assert.ok(error instanceof BadBody);
      assert.match(error.message, /blocked this server's network provider/);
      return true;
    }
  );

  assert.equal(calls, 1);
});

test('ChineseInLA login returns the server-issued isolated profile credential', async () => {
  const provider = new ChineseInLAProvider();
  const isolatedCredentials = {
    binaryPath: '/tmp/xiaohongshu-mcp',
    mcpEndpoint: 'http://127.0.0.1:32123/mcp',
    profileId: '1234567890abcdef12345678',
    profileName: 'ChineseInLA user',
    signature: 'signed-credential',
  };
  let setupKey = '';
  (provider as any).setupIsolatedCredentials = async (key: string) => {
    setupKey = key;
    return isolatedCredentials;
  };
  (provider as any).callMcpTool = async () =>
    JSON.stringify({ logged_in: true, message: 'already logged in' });

  const result = await provider.loginWithPassword(
    'organization-a\0user-a',
    {},
    'ChineseInLA user',
    'not-persisted'
  );

  assert.equal(setupKey, 'organization-a\0user-a');
  assert.equal(result.success, true);
  assert.deepEqual(
    JSON.parse(Buffer.from(result.code!, 'base64url').toString('utf8')),
    isolatedCredentials
  );
  assert.doesNotMatch(result.code!, /not-persisted/);
});
