import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InstagramStandaloneProvider } from './instagram.standalone.provider';
import { ChannelSetupError, NotEnoughScopes } from '../social.abstract';

const clientInformation = {
  client_id: '1630352765169674',
  client_secret: 'customer-instagram-app-secret',
  instanceUrl: 'https://post.example.test',
};

type Route = (url: URL, init?: RequestInit) => unknown;

const withFetch = async (routes: Route, run: () => Promise<void>) => {
  const previousFetch = globalThis.fetch;
  const previousFrontendUrl = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = 'https://post.example.test';
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const body = routes(new URL(String(input)), init);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = previousFrontendUrl;
    }
  }
};

const scopes = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_comments',
  'instagram_business_manage_insights',
];

test('Instagram Standalone builds the Instagram login URL for the customer app', async () => {
  await withFetch(
    () => ({}),
    async () => {
      const provider = new InstagramStandaloneProvider();
      const { url } = await provider.generateAuthUrl(clientInformation);
      const authorization = new URL(url);
      assert.equal(authorization.host, 'www.instagram.com');
      assert.equal(authorization.searchParams.get('enable_fb_login'), '0');
      assert.equal(
        authorization.searchParams.get('client_id'),
        clientInformation.client_id
      );
      assert.equal(
        authorization.searchParams.get('redirect_uri'),
        'https://post.example.test/integrations/social/instagram-standalone'
      );
      assert.equal(
        provider.validateCustomOAuthCredentials({
          ...clientInformation,
          client_id: 'not-numeric',
        }),
        'Enter the numeric Instagram App ID (from API setup with Instagram login)'
      );
    }
  );
});

test('Instagram Standalone surfaces Meta’s reason when the code exchange fails', async () => {
  await withFetch(
    (url) => {
      if (url.host === 'api.instagram.com') {
        return {
          error_type: 'OAuthException',
          code: 400,
          error_message: 'Invalid redirect_uri',
        };
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      const provider = new InstagramStandaloneProvider();
      await assert.rejects(
        () =>
          provider.authenticate(
            { code: 'abc', codeVerifier: '', refresh: '' },
            clientInformation
          ),
        (error: Error) => {
          assert.equal(error instanceof ChannelSetupError, true);
          assert.match(error.message, /Invalid redirect_uri/);
          assert.match(error.message, /redirect URL/);
          return true;
        }
      );
    }
  );
});

test('Instagram Standalone still reports missing scopes as NotEnoughScopes', async () => {
  await withFetch(
    (url) => {
      if (url.host === 'api.instagram.com') {
        return {
          access_token: 'short',
          user_id: '178',
          permissions: ['instagram_business_basic'],
        };
      }
      if (url.pathname === '/access_token') {
        return { access_token: 'long', expires_in: 5000000 };
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      const provider = new InstagramStandaloneProvider();
      await assert.rejects(
        () =>
          provider.authenticate(
            { code: 'abc', codeVerifier: '', refresh: '' },
            clientInformation
          ),
        (error: unknown) => error instanceof NotEnoughScopes
      );
    }
  );
});

test('Instagram Standalone returns the professional account on success', async () => {
  await withFetch(
    (url) => {
      if (url.host === 'api.instagram.com') {
        return { access_token: 'short', user_id: '178', permissions: scopes };
      }
      if (url.pathname === '/access_token') {
        return { access_token: 'long', expires_in: 5000000 };
      }
      if (/^\/v\d+\.\d+\/me$/.test(url.pathname)) {
        assert.equal(url.searchParams.get('access_token'), 'long');
        return {
          user_id: '178',
          username: 'tajimallp',
          name: 'Tajima LLP',
          profile_picture_url: 'p.jpg',
        };
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      const provider = new InstagramStandaloneProvider();
      const auth = await provider.authenticate(
        { code: 'abc', codeVerifier: '', refresh: '' },
        clientInformation
      );
      assert.equal(typeof auth, 'object');
      if (typeof auth === 'string') return;
      assert.equal(auth.id, '178');
      assert.equal(auth.username, 'tajimallp');
      assert.equal(auth.accessToken, 'long');
      assert.equal(auth.picture, 'p.jpg');
    }
  );
});

test('Instagram Standalone ships an assistant prompt with the callback placeholder', () => {
  const provider = new InstagramStandaloneProvider();
  const prompt = provider.oauthCredentialSetup.assistantPrompt || '';
  assert.match(prompt, /\{\{callbackUrl\}\}/);
  assert.match(prompt, /Instagram app ID/);
  assert.match(prompt, /instagram_business_content_publish/);
  assert.doesNotMatch(prompt, /https:\/\/post\.truegrit\.dev/);
});
