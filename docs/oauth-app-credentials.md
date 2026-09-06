# OAuth app credentials

Postiz can connect OAuth channels even when the server operator has not set the
provider's client ID and client secret. The Add Channel screen detects the
missing server configuration before starting OAuth and opens a setup form
instead of sending the user to a broken provider URL.

## Connect a channel with your own app

1. Open **Add Channel** and select the provider.
2. If the Postiz server has no credentials for it, use the developer-portal
   link in the setup window to create an OAuth application.
3. Copy the exact callback URL displayed by Postiz into the provider's allowed
   redirect/callback URL list. Preserve a trailing slash when one is shown.
4. Enable the scopes displayed by Postiz and complete any provider-specific
   review, product, or test-user setup listed in the window.
5. Paste the client ID and client secret into Postiz and select **Continue**.

The setup window is available for Facebook, Instagram (Facebook Login and the
standalone Instagram API), Threads, YouTube, Google Business Profile, LinkedIn
and LinkedIn Pages, Reddit, TikTok, TikTok Business, Pinterest, Dribbble,
Discord, Slack, Kick, Twitch, Mastodon, Tumblr, and any later provider that
declares `oauthCredentialSetup` metadata.

Discord also requires the server operator to set `DISCORD_BOT_TOKEN_ID` because
Discord does not return an application bot token through the OAuth flow.

## Server defaults

Operators can still configure credentials in `.env`. When both values are
present, Postiz uses the server app and keeps the existing one-click connection
flow. When either value is missing, the UI identifies only the missing field
names; it never returns configured values.

The provider classes are the source of truth for environment-variable aliases,
field labels, developer portal, documentation link, help steps, scopes, and any
callback-path exception. This keeps server detection and the browser guide in
sync.

## Security and lifecycle

- Credentials are submitted to the authenticated backend in a POST body. They
  are never added to the OAuth authorization URL or integration-list response.
- While OAuth is in progress, Postiz encrypts the credential object and stores
  it in Redis under the random OAuth state with a one-hour expiry.
- On successful connection, the encrypted credentials are stored in the
  integration's `customInstanceDetails`. Token refreshes receive the same
  credentials, so user-owned apps continue to work after the first access token
  expires.
- Public callback responses remove access tokens, refresh tokens, and custom
  credential details before returning integration data to the browser.

## Adding another OAuth provider

1. Add `customOAuthCredentials = true` and an `oauthCredentialSetup` object to
   the provider. Include environment aliases, labels, official links, concise
   setup steps, and `callbackPath` if its registered URL differs from the normal
   `/integrations/social/:identifier` path.
2. Resolve credentials with `resolveOAuthCredentials()` in
   `generateAuthUrl()`, `authenticate()`, and `refreshToken()`.
3. If normal publishing API calls also require the app ID or secret, retrieve
   the encrypted per-integration values with
   `resolveIntegrationOAuthCredentials()` instead of reading only process
   environment variables.
4. Verify both modes: complete server defaults should connect directly, while
   a missing value should open the setup form without an OAuth error.

## Design reference

This follows the setup pattern used by Hermes Agent: required credentials are
described with human-facing prompt/help metadata, missing values are detected
before executing the dependent operation, and secrets are handled separately
from ordinary configuration. See the official Hermes Agent
[quickstart](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/quickstart.md),
[environment-variable reference](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/reference/environment-variables.md),
and [configuration guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md).
