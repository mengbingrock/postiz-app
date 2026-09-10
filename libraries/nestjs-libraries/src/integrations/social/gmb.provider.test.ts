import assert from 'node:assert/strict';
import test from 'node:test';
import { GmbProvider } from './gmb.provider';
import { ChannelSetupError } from '../social.abstract';

type Route = (url: URL) => { status?: number; body: unknown };

const withFetch = async (routes: Route, run: () => Promise<void>) => {
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  console.error = () => undefined;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    const { status = 200, body } = routes(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    console.error = previousError;
  }
};

const accountsHost = 'mybusinessaccountmanagement.googleapis.com';
const infoHost = 'mybusinessbusinessinformation.googleapis.com';

test('GMB pages enumerates every account and each account’s locations', async () => {
  const calls: string[] = [];
  await withFetch(
    (url) => {
      calls.push(url.pathname + (url.searchParams.get('pageToken') || ''));
      if (url.host === accountsHost) {
        return url.searchParams.get('pageToken')
          ? {
              body: {
                accounts: [
                  { name: 'accounts/3', accountName: 'Group', type: 'LOCATION_GROUP' },
                ],
              },
            }
          : {
              body: {
                accounts: [
                  { name: 'accounts/1', accountName: 'Me', type: 'PERSONAL' },
                  { name: 'accounts/2', accountName: 'Org', type: 'ORGANIZATION' },
                ],
                nextPageToken: 'p2',
              },
            };
      }
      if (url.pathname === '/v1/accounts/1/locations') {
        return { body: { locations: [] } };
      }
      if (url.pathname === '/v1/accounts/2/locations') {
        return {
          status: 429,
          body: { error: { message: 'Quota exceeded for quota metric Requests' } },
        };
      }
      if (url.pathname === '/v1/accounts/3/locations') {
        return url.searchParams.get('pageToken')
          ? { body: { locations: [{ name: 'locations/20', title: 'Second' }] } }
          : {
              body: {
                locations: [{ name: 'locations/10', title: 'First' }],
                nextPageToken: 'l2',
              },
            };
      }
      if (url.pathname.endsWith('/media')) {
        return {
          body: {
            mediaItems: [
              {
                mediaFormat: 'PHOTO',
                locationAssociation: { category: 'PROFILE' },
                googleUrl: `https://img.example/${url.pathname.split('/')[3]}`,
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const pages = await new GmbProvider().pages('token');
      assert.deepEqual(
        pages.map((page) => [page.id, page.name, page.picture.data.url]),
        [
          ['accounts/3/locations/10', 'First', 'https://img.example/10'],
          ['accounts/3/locations/20', 'Second', 'https://img.example/20'],
        ]
      );
      assert.ok(calls.includes('/v1/accountsp2'), 'follows account pagination');
      assert.ok(calls.includes('/v1/accounts/3/locationsl2'), 'follows location pagination');
      assert.ok(calls.includes('/v1/accounts/2/locations'), 'checks every account');
    }
  );
});

test('GMB pages explains a rejected account list instead of returning nothing', async () => {
  await withFetch(
    (url) =>
      url.host === accountsHost
        ? {
            status: 403,
            body: {
              error: {
                message:
                  'My Business Account Management API has not been used in project 123 before or it is disabled.',
              },
            },
          }
        : { body: {} },
    async () => {
      await assert.rejects(
        new GmbProvider().pages('token'),
        (error: unknown) =>
          error instanceof ChannelSetupError &&
          /HTTP 403: My Business Account Management API has not been used/.test(
            error.message
          ) &&
          /Account Management API/.test(error.message)
      );
    }
  );
});

test('GMB pages reports the accounts it found when none has a location', async () => {
  await withFetch(
    (url) => {
      if (url.host === accountsHost) {
        return {
          body: {
            accounts: [
              { name: 'accounts/1', accountName: 'Me', type: 'PERSONAL', role: 'PRIMARY_OWNER' },
              { name: 'accounts/2', accountName: 'Org', type: 'ORGANIZATION' },
            ],
          },
        };
      }
      if (url.pathname === '/v1/accounts/1/locations') {
        return { body: {} };
      }
      return { status: 403, body: { error: { message: 'PERMISSION_DENIED' } } };
    },
    async () => {
      await assert.rejects(
        new GmbProvider().pages('token'),
        (error: unknown) =>
          error instanceof ChannelSetupError &&
          error.message.includes('2 Business Profile account(s)') &&
          error.message.includes('accounts/1 "Me" [PERSONAL/PRIMARY_OWNER]') &&
          error.message.includes('accounts/2 "Org" [ORGANIZATION]: HTTP 403: PERMISSION_DENIED')
      );
    }
  );
});
