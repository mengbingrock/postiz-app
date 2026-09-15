import assert from 'node:assert/strict';
import test from 'node:test';
import { LinkedinPageProvider } from './linkedin.page.provider';

test('LinkedIn Page uses its dedicated Community Management app', async () => {
  const previous = {
    frontendUrl: process.env.FRONTEND_URL,
    linkedinClientId: process.env.LINKEDIN_CLIENT_ID,
    linkedinClientSecret: process.env.LINKEDIN_CLIENT_SECRET,
    linkedinPageClientId: process.env.LINKEDIN_PAGE_CLIENT_ID,
    linkedinPageClientSecret: process.env.LINKEDIN_PAGE_CLIENT_SECRET,
  };

  process.env.FRONTEND_URL = 'https://post.example.test';
  process.env.LINKEDIN_CLIENT_ID = 'personal-client-id';
  process.env.LINKEDIN_CLIENT_SECRET = 'personal-client-secret';
  process.env.LINKEDIN_PAGE_CLIENT_ID = 'page-client-id';
  process.env.LINKEDIN_PAGE_CLIENT_SECRET = 'page-client-secret';

  try {
    const provider = new LinkedinPageProvider();
    const { url } = await provider.generateAuthUrl();
    const authorization = new URL(url);

    assert.equal(authorization.searchParams.get('client_id'), 'page-client-id');
    assert.equal(
      authorization.searchParams.get('redirect_uri'),
      'https://post.example.test/integrations/social/linkedin-page'
    );
    assert.deepEqual(authorization.searchParams.get('scope')?.split(' '), [
      'r_basicprofile',
      'rw_organization_admin',
      'w_organization_social',
      'r_organization_social',
    ]);
    // LinkedIn decides whether consent is required from the member's current
    // app grant. Do not request a silent authorization flow here.
    assert.equal(authorization.searchParams.has('prompt'), false);
    assert.equal(url.includes('page-client-secret'), false);
  } finally {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    };
    restore('FRONTEND_URL', previous.frontendUrl);
    restore('LINKEDIN_CLIENT_ID', previous.linkedinClientId);
    restore('LINKEDIN_CLIENT_SECRET', previous.linkedinClientSecret);
    restore('LINKEDIN_PAGE_CLIENT_ID', previous.linkedinPageClientId);
    restore('LINKEDIN_PAGE_CLIENT_SECRET', previous.linkedinPageClientSecret);
  }
});

test('LinkedIn Page loads Page details when the ACL response has no inline projection', async () => {
  const previousFetch = globalThis.fetch;
  const requestedUrls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes('/rest/organizationAcls?')) {
      return new Response(
        JSON.stringify({
          elements: [
            {
              role: 'ADMINISTRATOR',
              state: 'APPROVED',
              organization: 'urn:li:organization:143547008',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('/v2/organizations/143547008?')) {
      return new Response(
        JSON.stringify({
          id: 143547008,
          localizedName: 'TrueGrit AI',
          vanityName: 'truegrit-ai',
          logoV2: {
            'original~': {
              elements: [
                {
                  identifiers: [{ identifier: 'https://img.example/page.png' }],
                },
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
    const provider = new LinkedinPageProvider();
    assert.deepEqual(await provider.companies('access-token'), [
      {
        id: '143547008',
        page: '143547008',
        username: 'truegrit-ai',
        name: 'TrueGrit AI',
        picture: 'https://img.example/page.png',
      },
    ]);
    assert.equal(
      requestedUrls.some((url) => url.includes('organizationalTarget~')),
      false
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
