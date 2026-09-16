import assert from 'node:assert/strict';
import test from 'node:test';
import { InstagramProvider } from './instagram.provider';
import { ChannelSetupError } from '../social.abstract';

const clientInformation = {
  client_id: '123456789012345',
  client_secret: 'customer-meta-app-secret',
  instanceUrl: 'https://post.example.test',
};

test('Instagram Facebook Business requires a customer-owned Meta app', () => {
  const provider = new InstagramProvider();

  assert.equal(provider.customOAuthCredentials, true);
  assert.equal(provider.alwaysRequireCustomOAuthCredentials, true);
  assert.equal(
    provider.validateCustomOAuthCredentials(clientInformation),
    undefined
  );
  assert.equal(
    provider.validateCustomOAuthCredentials({
      ...clientInformation,
      client_id: 'not-a-meta-app-id',
    }),
    'Enter a valid numeric Meta App ID'
  );
});

test('Instagram Facebook Business authorizes with the customer Meta app', async () => {
  const previousFrontendUrl = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = 'https://post.example.test';

  try {
    const provider = new InstagramProvider();
    const { url } = await provider.generateAuthUrl(clientInformation);
    const authorization = new URL(url);

    assert.equal(
      authorization.searchParams.get('client_id'),
      clientInformation.client_id
    );
    assert.equal(
      authorization.searchParams.get('redirect_uri'),
      'https://post.example.test/integrations/social/instagram'
    );
    assert.equal(url.includes(clientInformation.client_secret), false);
  } finally {
    if (previousFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = previousFrontendUrl;
    }
  }
});

type Route = (url: URL) => unknown;

const withFetch = async (routes: Route, run: () => Promise<void>) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const body = routes(new URL(String(input)));
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
  }
};

const graphPath = (url: URL) => url.pathname.replace(/^\/v\d+\.\d+/, '');

test('Instagram pages explains when no Page has an Instagram account linked', async () => {
  await withFetch(
    (url) => {
      switch (graphPath(url)) {
        case '/me/accounts':
          return { data: [{ id: '1100', name: 'Tajima LLP' }] };
        case '/me/businesses':
          return { data: [] };
        default:
          throw new Error(`unexpected ${url}`);
      }
    },
    async () => {
      const provider = new InstagramProvider();
      await assert.rejects(
        () => provider.pages('page-token___user-token'),
        (error: Error) => {
          assert.equal(error instanceof ChannelSetupError, true);
          assert.match(error.message, /1 Facebook Page\(s\) \(Tajima LLP\)/);
          assert.match(error.message, /Instagram accounts/);
          return true;
        }
      );
    }
  );
});

test('Instagram pages explains when Meta returned no Pages at all', async () => {
  await withFetch(
    (url) =>
      graphPath(url) === '/me/businesses' ? { data: [] } : { data: [] },
    async () => {
      const provider = new InstagramProvider();
      await assert.rejects(
        () => provider.pages('page-token___user-token'),
        /returned no Facebook Pages/
      );
    }
  );
});

test('Instagram pages lists the Instagram accounts linked to Pages', async () => {
  await withFetch(
    (url) => {
      switch (graphPath(url)) {
        case '/me/accounts':
          return {
            data: [
              { id: '1', name: 'No Instagram' },
              {
                id: '2',
                name: 'TrueGrit AI',
                instagram_business_account: { id: '178' },
              },
            ],
          };
        case '/me/businesses':
          return { data: [] };
        case '/178':
          return { name: 'bingbingbang91', profile_picture_url: 'p.jpg' };
        default:
          throw new Error(`unexpected ${url}`);
      }
    },
    async () => {
      const provider = new InstagramProvider();
      const pages = await provider.pages('page-token___user-token');
      assert.deepEqual(pages, [
        {
          pageId: '2',
          id: '178',
          name: 'bingbingbang91',
          picture: { data: { url: 'p.jpg' } },
        },
      ]);
    }
  );
});
