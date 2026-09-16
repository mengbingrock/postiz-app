import assert from 'node:assert/strict';
import test from 'node:test';
import { TiktokCloudProvider } from './tiktok.cloud.provider';
import { BadBody, ChannelSetupError } from '../social.abstract';

const clientInformation = {
  client_id: 'pca_customerClientId123',
  client_secret: 'pcs_customerClientSecret456',
  instanceUrl: 'https://post.example.test',
};

type Call = { url: string; init?: RequestInit };
type Route = (call: Call) => { status?: number; body: unknown };

const withFetch = async (routes: Route, run: (calls: Call[]) => Promise<void>) => {
  const previousFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    const { status = 200, body } = routes(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = previousFetch;
  }
};

const cloudIntegrations = [
  { id: 'cloud-tt-1', name: 'truegritai', identifier: 'tiktok', picture: 'https://img/1.png' },
  { id: 'cloud-li-1', name: 'Martin', identifier: 'linkedin' },
  { id: 'cloud-tt-2', name: 'old', identifier: 'tiktok', disabled: true },
  { id: 'cloud-ttb-1', name: 'Brand', identifier: 'tiktok-business', picture: null },
];

test('TikTok via Postiz Cloud sends the user to the Postiz Cloud consent screen', async () => {
  const provider = new TiktokCloudProvider();
  const { url, state, codeVerifier } = await provider.generateAuthUrl(clientInformation);
  const authorization = new URL(url);

  assert.equal(authorization.origin, 'https://platform.postiz.com');
  assert.equal(authorization.pathname, '/oauth/authorize');
  assert.equal(authorization.searchParams.get('client_id'), clientInformation.client_id);
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('state'), state);
  assert.equal(codeVerifier, state);
  assert.equal(
    provider.validateCustomOAuthCredentials({ ...clientInformation, client_id: 'nope' }),
    'Enter a valid Postiz Cloud Client ID (it starts with pca_)'
  );
});

test('TikTok via Postiz Cloud exchanges the code for a pos_ token', async () => {
  await withFetch(
    ({ url, init }) => {
      assert.equal(url, 'https://api.postiz.com/oauth/token');
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, {
        grant_type: 'authorization_code',
        code: 'abc123',
        client_id: clientInformation.client_id,
        client_secret: clientInformation.client_secret,
      });
      return { body: { id: 'org_1', access_token: 'pos_token', token_type: 'bearer' } };
    },
    async () => {
      const auth = await new TiktokCloudProvider().authenticate(
        { code: 'abc123', codeVerifier: 'state' },
        clientInformation
      );
      assert.notEqual(typeof auth, 'string');
      if (typeof auth === 'string') return;
      assert.equal(auth.accessToken, 'pos_token');
      assert.equal(auth.refreshToken, 'pos_token');
      assert.equal(auth.id, 'postiz-cloud-org_1');
    }
  );
});

test('TikTok via Postiz Cloud lists only enabled TikTok channels of the cloud account', async () => {
  await withFetch(
    ({ url, init }) => {
      assert.equal(url, 'https://api.postiz.com/public/v1/integrations');
      assert.equal((init?.headers as any).Authorization, 'pos_token');
      return { body: cloudIntegrations };
    },
    async () => {
      const provider = new TiktokCloudProvider();
      const pages = await provider.pages('pos_token');
      assert.deepEqual(
        pages.map((page) => [page.id, page.name, page.identifier, page.picture.data.url]),
        [
          ['cloud-tt-1', 'truegritai', 'tiktok', 'https://img/1.png'],
          ['cloud-ttb-1', 'Brand', 'tiktok-business', ''],
        ]
      );
      const information = await provider.fetchPageInformation('pos_token', { id: 'cloud-ttb-1' });
      assert.equal(information.id, 'cloud-ttb-1');
      assert.equal(information.access_token, 'pos_token');
    }
  );
});

test('TikTok via Postiz Cloud fetches the cloud org invite link for TikTok', async () => {
  await withFetch(
    ({ url, init }) => {
      assert.equal(url, 'https://api.postiz.com/public/v1/social/tiktok-business');
      assert.equal((init?.headers as any).Authorization, 'pos_token');
      return { body: { url: 'https://www.tiktok.com/v2/auth/authorize/?state=abc' } };
    },
    async () => {
      assert.deepEqual(await new TiktokCloudProvider().inviteLink('pos_token'), {
        url: 'https://www.tiktok.com/v2/auth/authorize/?state=abc',
        expiresInMinutes: 60,
      });
    }
  );
});

test('TikTok via Postiz Cloud live-verifies the channel against the cloud', async () => {
  const provider = new TiktokCloudProvider();
  await withFetch(
    () => ({ body: cloudIntegrations }),
    async () => {
      const ok = await provider.checkChannel({ token: 'pos_token', internalId: 'cloud-tt-1' } as any);
      assert.equal(ok.status, 'working');
      assert.match(ok.message, /truegritai/);

      const gone = await provider.checkChannel({ token: 'pos_token', internalId: 'cloud-missing' } as any);
      assert.equal(gone.status, 'reconnect_required');

      const disabled = await provider.checkChannel({ token: 'pos_token', internalId: 'cloud-tt-2' } as any);
      assert.equal(disabled.status, 'reconnect_required');
    }
  );
  await withFetch(
    () => ({ status: 401, body: { message: 'Unauthorized' } }),
    async () => {
      const revoked = await provider.checkChannel({ token: 'pos_token', internalId: 'cloud-tt-1' } as any);
      assert.equal(revoked.status, 'reconnect_required');
    }
  );
});

test('TikTok via Postiz Cloud explains when the cloud account has no TikTok channel', async () => {
  await withFetch(
    () => ({ body: [{ id: 'x', name: 'x', identifier: 'linkedin' }] }),
    async () => {
      await assert.rejects(
        new TiktokCloudProvider().pages('pos_token'),
        (error: unknown) =>
          error instanceof ChannelSetupError && /no TikTok channel/.test(error.message)
      );
    }
  );
});

test('TikTok via Postiz Cloud imports media, creates the cloud post and reports it pending', async () => {
  await withFetch(
    ({ url, init }) => {
      if (url.endsWith('/public/v1/integrations')) return { body: cloudIntegrations };
      if (url.endsWith('/public/v1/upload-from-url')) {
        const { url: source } = JSON.parse(String(init?.body));
        assert.equal(source, 'https://post.example.test/uploads/clip.mp4');
        return { body: { id: 'media-1', path: 'https://uploads.postiz.com/clip.mp4' } };
      }
      if (url.endsWith('/public/v1/posts')) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.type, 'now');
        assert.deepEqual(body.tags, []);
        assert.deepEqual(body.posts[0].integration, { id: 'cloud-ttb-1' });
        assert.deepEqual(body.posts[0].value[0].image, [
          { id: 'media-1', path: 'https://uploads.postiz.com/clip.mp4' },
        ]);
        assert.equal(body.posts[0].value[0].content, '<p>Hello TikTok</p>');
        assert.equal(body.posts[0].settings.__type, 'tiktok-business');
        assert.equal(body.posts[0].settings.privacy_level, 'SELF_ONLY');
        assert.equal(body.posts[0].settings.content_posting_method, 'DIRECT_POST');
        return { body: [{ postId: 'cloud-post-9', integration: 'cloud-ttb-1' }] };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const [result] = await new TiktokCloudProvider().postPending(
        'local-post',
        'pos_token',
        [
          {
            id: 'local-post',
            message: '<p>Hello TikTok</p>',
            settings: {
              __type: 'tiktok-cloud',
              title: 'Hello',
              privacy_level: 'SELF_ONLY',
              content_posting_method: 'DIRECT_POST',
            } as any,
            media: [{ id: 'm', path: 'https://post.example.test/uploads/clip.mp4' }],
          },
        ] as any,
        { internalId: 'cloud-ttb-1' } as any
      );
      assert.equal(result.status, 'pending');
      assert.equal(result.postId, 'cloud-post-9');
      assert.equal(result.pendingData.cloudPostId, 'cloud-post-9');
    }
  );
});

test('TikTok via Postiz Cloud skips consent and credentials with a server-wide token', async () => {
  const previousToken = process.env.POSTIZ_CLOUD_TOKEN;
  const previousFrontend = process.env.FRONTEND_URL;
  process.env.POSTIZ_CLOUD_TOKEN = 'server-cloud-key';
  process.env.FRONTEND_URL = 'https://post.example.test';
  try {
    const provider = new TiktokCloudProvider();
    assert.equal(provider.customOAuthCredentials, false);
    assert.equal(provider.oauthCredentialSetup, undefined);

    const { url, state } = await provider.generateAuthUrl();
    const callback = new URL(url);
    assert.equal(callback.origin, 'https://post.example.test');
    assert.equal(callback.pathname, '/integrations/social/tiktok-cloud');
    assert.equal(callback.searchParams.get('code'), 'postiz-cloud-server-token');
    assert.equal(callback.searchParams.get('state'), state);

    const auth = await provider.authenticate({ code: 'postiz-cloud-server-token', codeVerifier: state });
    assert.notEqual(typeof auth, 'string');
    if (typeof auth === 'string') return;
    assert.equal(auth.accessToken, 'postiz-cloud:server-token');

    await withFetch(
      ({ init }) => {
        assert.equal((init?.headers as any).Authorization, 'server-cloud-key');
        return { body: cloudIntegrations };
      },
      async () => {
        const information = await provider.fetchPageInformation(auth.accessToken, { id: 'cloud-tt-1' });
        assert.equal(information.access_token, 'postiz-cloud:server-token');
      }
    );

    delete process.env.POSTIZ_CLOUD_TOKEN;
    await assert.rejects(
      provider.pages('postiz-cloud:server-token'),
      (error: unknown) =>
        error instanceof ChannelSetupError && /POSTIZ_CLOUD_TOKEN is no longer set/.test(error.message)
    );
  } finally {
    if (previousToken === undefined) delete process.env.POSTIZ_CLOUD_TOKEN;
    else process.env.POSTIZ_CLOUD_TOKEN = previousToken;
    if (previousFrontend === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontend;
  }
});

test('TikTok via Postiz Cloud maps the cloud post state to the workflow status', async () => {
  const pendingData = { cloudPostId: 'cloud-post-9', createdAt: '2026-09-14T06:00:00.000Z' };
  const provider = new TiktokCloudProvider();
  const integration = {} as any;

  await withFetch(
    ({ url }) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, '/public/v1/posts');
      assert.equal(parsed.searchParams.get('startDate'), '2026-09-13T06:00:00');
      assert.equal(parsed.searchParams.get('endDate'), '2026-09-15T06:00:00');
      return { body: { posts: [{ id: 'cloud-post-9', state: 'QUEUE' }] } };
    },
    async () => {
      assert.deepEqual(await provider.checkPostStatus('pos_token', pendingData, integration), {
        status: 'pending',
        pendingData,
      });
    }
  );

  await withFetch(
    () => ({
      body: {
        posts: [
          {
            id: 'cloud-post-9',
            state: 'PUBLISHED',
            releaseURL: 'https://www.tiktok.com/@truegritai/video/1',
            releaseId: '1',
          },
        ],
      },
    }),
    async () => {
      assert.deepEqual(await provider.checkPostStatus('pos_token', pendingData, integration), {
        status: 'completed',
        releaseURL: 'https://www.tiktok.com/@truegritai/video/1',
        postId: '1',
      });
    }
  );

  await withFetch(
    () => ({
      body: {
        posts: [{ id: 'cloud-post-9', state: 'ERROR', error: 'App not approved for public posting' }],
      },
    }),
    async () => {
      await assert.rejects(
        provider.checkPostStatus('pos_token', pendingData, integration),
        (error: unknown) =>
          error instanceof BadBody && /App not approved for public posting/.test(error.message)
      );
    }
  );
});
