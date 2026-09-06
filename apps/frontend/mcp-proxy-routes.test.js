import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPostizBackendRewrites,
  isPostizBackendProxyPath,
} from './mcp-proxy-routes.js';

test('recognizes MCP protocol, discovery, and backend OAuth routes', () => {
  for (const path of [
    '/mcp',
    '/mcp/an-api-key',
    '/mcp-oauth',
    '/mcp-oauth-claude',
    '/sse/an-api-key',
    '/message/an-api-key',
    '/.well-known/oauth-protected-resource/mcp-oauth',
    '/.well-known/oauth-authorization-server/mcp-oauth',
    '/.well-known/openid-configuration/mcp-oauth',
    '/.well-known/openai-apps-challenge',
    '/oauth/token',
    '/oauth/register',
    '/oauth/userinfo',
  ]) {
    assert.equal(isPostizBackendProxyPath(path), true, path);
  }
});

test('keeps frontend and similarly named routes in Next.js', () => {
  for (const path of [
    '/oauth/authorize',
    '/auth',
    '/launches',
    '/mcpx',
    '/.well-known/unrelated',
  ]) {
    assert.equal(isPostizBackendProxyPath(path), false, path);
  }
});

test('builds internal rewrites without a double slash', () => {
  const rewrites = buildPostizBackendRewrites('http://127.0.0.1:3003/');
  assert.deepEqual(
    rewrites.find(({ source }) => source === '/mcp/:path*'),
    {
      source: '/mcp/:path*',
      destination: 'http://127.0.0.1:3003/mcp/:path*',
    }
  );
  assert.deepEqual(
    rewrites.find(({ source }) => source === '/oauth/token'),
    {
      source: '/oauth/token',
      destination: 'http://127.0.0.1:3003/oauth/token',
    }
  );
});
