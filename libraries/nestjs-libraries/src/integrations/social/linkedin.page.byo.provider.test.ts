import assert from 'node:assert/strict';
import test from 'node:test';
import { LinkedinPageByoProvider } from './linkedin.page.byo.provider';

const clientInformation = {
  client_id: 'linkedin-client-id',
  client_secret: 'linkedin-client-secret',
} as any;

test('LinkedIn Page Own App requests Community Management scopes without OIDC', async () => {
  const previousFrontendUrl = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = 'https://post.example.test';

  try {
    const provider = new LinkedinPageByoProvider();
    const { url } = await provider.generateAuthUrl(clientInformation);
    const authorization = new URL(url);
    const scopes = authorization.searchParams.get('scope')?.split(' ') || [];

    assert.deepEqual(scopes, [
      'r_basicprofile',
      'rw_organization_admin',
      'w_organization_social',
      'r_organization_social',
    ]);
    assert.equal(
      authorization.searchParams.get('redirect_uri'),
      'https://post.example.test/integrations/social/linkedin-page-byo'
    );
  } finally {
    if (previousFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = previousFrontendUrl;
    }
  }
});

test('LinkedIn Page Own App authenticates with r_basicprofile instead of userinfo', async () => {
  const previousFetch = globalThis.fetch;
  const previousFrontendUrl = process.env.FRONTEND_URL;
  const requestedUrls: string[] = [];
  process.env.FRONTEND_URL = 'https://post.example.test';

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);

    if (url.endsWith('/oauth/v2/accessToken')) {
      return new Response(
        JSON.stringify({
          access_token: 'access-token',
          expires_in: 3600,
          refresh_token: 'refresh-token',
          scope:
            'r_basicprofile,rw_organization_admin,w_organization_social,r_organization_social',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.startsWith('https://api.linkedin.com/v2/me?')) {
      return new Response(
        JSON.stringify({
          id: 'member-id',
          localizedFirstName: 'Martin',
          localizedLastName: 'Wang',
          vanityName: 'martin-wang',
          profilePicture: {
            'displayImage~': {
              elements: [
                { identifiers: [{ identifier: 'https://img.example/me.jpg' }] },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const provider = new LinkedinPageByoProvider();
    const result = await provider.authenticate(
      { code: 'authorization-code', codeVerifier: 'unused' },
      clientInformation
    );

    assert.deepEqual(result, {
      id: 'member-id',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      name: 'Martin Wang',
      picture: 'https://img.example/me.jpg',
      username: 'martin-wang',
    });
    assert.equal(
      requestedUrls.some((url) => url.endsWith('/userinfo')),
      false
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = previousFrontendUrl;
    }
  }
});
