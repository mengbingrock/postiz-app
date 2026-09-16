import assert from 'node:assert/strict';
import test from 'node:test';
import { GmbCloudProvider } from './gmb.cloud.provider';
import { ChannelSetupError } from '../social.abstract';

type Call = { url: string; init?: RequestInit };
type Route = (call: Call) => { status?: number; body: unknown };

const withFetch = async (routes: Route, run: () => Promise<void>) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const { status = 200, body } = routes({ url: String(input), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
  }
};

const cloudIntegrations = [
  { id: 'cloud-gmb-1', name: 'TrueGrit HQ', identifier: 'gmb', picture: null },
  { id: 'cloud-tt-1', name: 'truegritai', identifier: 'tiktok-business' },
];

test('Google Business via Postiz Cloud is registered as gmb-cloud', () => {
  const provider = new GmbCloudProvider();
  assert.equal(provider.identifier, 'gmb-cloud');
  assert.equal(provider.isBetweenSteps, true);
  assert.equal(provider.maxLength(), 1500);
  assert.equal(
    provider.validateCustomOAuthCredentials({
      client_id: 'nope',
      client_secret: 'pcs_secretsecret',
      instanceUrl: '',
    }),
    'Enter a valid Postiz Cloud Client ID (it starts with pca_)'
  );
});

test('Google Business via Postiz Cloud lists only gmb channels and mints a gmb invite link', async () => {
  await withFetch(
    ({ url }) => {
      if (url.endsWith('/public/v1/integrations')) return { body: cloudIntegrations };
      if (url.endsWith('/public/v1/social/gmb')) {
        return { body: { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=x' } };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const provider = new GmbCloudProvider();
      const pages = await provider.pages('pos_token');
      assert.deepEqual(
        pages.map((page) => [page.id, page.name, page.identifier]),
        [['cloud-gmb-1', 'TrueGrit HQ', 'gmb']]
      );
      assert.equal(
        (await provider.inviteLink('pos_token')).url,
        'https://accounts.google.com/o/oauth2/v2/auth?state=x'
      );
    }
  );
});

test('Google Business via Postiz Cloud explains when the cloud has no location', async () => {
  await withFetch(
    () => ({ body: [{ id: 'cloud-tt-1', name: 'truegritai', identifier: 'tiktok-business' }] }),
    async () => {
      await assert.rejects(
        new GmbCloudProvider().pages('pos_token'),
        (error: unknown) =>
          error instanceof ChannelSetupError &&
          /no Google Business Profile channel/.test(error.message)
      );
    }
  );
});

test('Google Business via Postiz Cloud posts text-only updates with gmb settings', async () => {
  await withFetch(
    ({ url, init }) => {
      if (url.endsWith('/public/v1/integrations')) return { body: cloudIntegrations };
      if (url.endsWith('/public/v1/posts')) {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.posts[0].integration, { id: 'cloud-gmb-1' });
        assert.deepEqual(body.posts[0].value[0].image, []);
        assert.equal(body.posts[0].settings.__type, 'gmb');
        assert.equal(body.posts[0].settings.topicType, 'STANDARD');
        return { body: [{ postId: 'cloud-post-1', integration: 'cloud-gmb-1' }] };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const [result] = await new GmbCloudProvider().postPending(
        'local-post',
        'pos_token',
        [
          {
            id: 'local-post',
            message: '<p>We are open late this week</p>',
            settings: { __type: 'gmb-cloud', topicType: 'STANDARD' } as any,
            media: [],
          },
        ] as any,
        { internalId: 'cloud-gmb-1' } as any
      );
      assert.equal(result.status, 'pending');
      assert.equal(result.postId, 'cloud-post-1');
    }
  );
});
