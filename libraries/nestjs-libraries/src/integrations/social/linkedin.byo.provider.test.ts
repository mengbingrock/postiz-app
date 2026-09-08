import assert from 'node:assert/strict';
import test from 'node:test';
import { LinkedinByoProvider } from './linkedin.byo.provider';

const clientInformation = {
  client_id: 'customer-linkedin-client-id',
  client_secret: 'customer-linkedin-client-secret',
  instanceUrl: 'https://post.example.test',
};

test('LinkedIn Personal Own App uses the customer app and its own callback', async () => {
  const previousFrontendUrl = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = 'https://post.example.test';

  try {
    const provider = new LinkedinByoProvider();
    const { url } = await provider.generateAuthUrl(clientInformation);
    const authorization = new URL(url);

    assert.equal(
      authorization.searchParams.get('client_id'),
      clientInformation.client_id
    );
    assert.equal(
      authorization.searchParams.get('redirect_uri'),
      'https://post.example.test/integrations/social/linkedin-byo'
    );
    assert.deepEqual(authorization.searchParams.get('scope')?.split(' '), [
      'openid',
      'profile',
      'w_member_social',
    ]);
    assert.equal(url.includes(clientInformation.client_secret), false);
  } finally {
    if (previousFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = previousFrontendUrl;
    }
  }
});

test('LinkedIn Personal Own App exchanges OAuth code with supplied credentials', async () => {
  const previousFetch = globalThis.fetch;
  const previousFrontendUrl = process.env.FRONTEND_URL;
  let tokenBody: URLSearchParams | undefined;
  process.env.FRONTEND_URL = 'https://post.example.test';

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = String(input);
    if (url.endsWith('/oauth/v2/accessToken')) {
      tokenBody = init?.body as URLSearchParams;
      return new Response(
        JSON.stringify({
          access_token: 'customer-access-token',
          expires_in: 3600,
          refresh_token: 'customer-refresh-token',
          scope: 'openid,profile,w_member_social',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.endsWith('/v2/userinfo')) {
      return new Response(
        JSON.stringify({
          sub: 'customer-member-id',
          name: 'Customer Member',
          picture: 'https://img.example/customer.jpg',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.endsWith('/v2/me')) {
      return new Response(JSON.stringify({ vanityName: 'customer-member' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const provider = new LinkedinByoProvider();
    const result = await provider.authenticate(
      { code: 'authorization-code', codeVerifier: 'unused' },
      clientInformation
    );

    assert.equal(tokenBody?.get('client_id'), clientInformation.client_id);
    assert.equal(
      tokenBody?.get('client_secret'),
      clientInformation.client_secret
    );
    assert.equal(
      tokenBody?.get('redirect_uri'),
      'https://post.example.test/integrations/social/linkedin-byo'
    );
    assert.deepEqual(result, {
      id: 'customer-member-id',
      accessToken: 'customer-access-token',
      refreshToken: 'customer-refresh-token',
      expiresIn: 3600,
      name: 'Customer Member',
      picture: 'https://img.example/customer.jpg',
      username: 'customer-member',
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = previousFrontendUrl;
    }
  }
});
