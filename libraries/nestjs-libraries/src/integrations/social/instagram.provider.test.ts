import assert from 'node:assert/strict';
import test from 'node:test';
import { InstagramProvider } from './instagram.provider';

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
