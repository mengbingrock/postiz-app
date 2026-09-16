# Channels via Postiz Cloud (TikTok, Google Business Profile)

Both `tiktok-cloud` and `gmb-cloud` are built on the same base
(`postiz.cloud.provider.ts` + the `createPostizCloudContinue` picker): a
platform whose app needs an audit/approval is published through the channel
connected in a Postiz Cloud account. Everything below is written for TikTok;
**Google Business (via Postiz Cloud)** works identically with cloud channel
type `gmb` (invite link → Google consent → pick the location), the
`GmbSettingsDto` settings (topic type, call to action, event/offer fields)
and text-only posts allowed — and it sidesteps the Business Profile API
enablement / quota-approval problem of a Google Cloud project of our own.

# TikTok via Postiz Cloud

Publishing to TikTok normally needs a TikTok developer app that has passed
TikTok's audit (unaudited apps can only post to *private* accounts, and only as
"Only me"). This channel type sidesteps that: it publishes through the TikTok
channel connected in a **Postiz Cloud** account (platform.postiz.com), which
runs an audited TikTok app, using Postiz's OAuth2 for third-party apps
(<https://docs.postiz.com/public-api/oauth>).

```
self-hosted Postiz ──OAuth2 (pca_/pcs_ app)──▶ platform.postiz.com  (user consents)
        │                                              │
        └── pos_ token ──▶ api.postiz.com/public/v1 ──▶ TikTok (Postiz Cloud's audited app)
```

Provider identifier: `tiktok-cloud`. Post settings are the same `TikTokDto`
as the direct TikTok channel (`content_posting_method`, `privacy_level`, duet /
stitch / comment, `autoAddMusic`, brand toggles, `video_made_with_ai`).

## One-time setup

1. In **Postiz Cloud** (platform.postiz.com): connect the TikTok account
   (Add channel → TikTok). Any TikTok / TikTok Business channel there can be
   used.
2. Postiz Cloud → **Settings → Developers → Apps → Create OAuth App**:
   - Redirect URL: `https://<your-instance>/integrations/social/tiktok-cloud`
     (for us: `https://post.truegrit.dev/integrations/social/tiktok-cloud`)
   - Copy the **Client ID** (`pca_…`) and **Client Secret** (`pcs_…`, shown
     once).
3. Give them to this instance — either per connection in the setup window
   that opens when adding the channel, or server-wide in `.env`:
   ```
   POSTIZ_CLOUD_CLIENT_ID=pca_...
   POSTIZ_CLOUD_CLIENT_SECRET=pcs_...
   # optional, defaults shown
   POSTIZ_CLOUD_FRONTEND_URL=https://platform.postiz.com
   POSTIZ_CLOUD_BACKEND_URL=https://api.postiz.com
   ```

## Self-serve mode: `POSTIZ_CLOUD_TOKEN` (recommended for a team)

If the instance owns the cloud account, set the cloud account's API key
(Postiz Cloud → Settings → Developers → Access → API Key, or a `pos_` grant)
server-wide:

```
POSTIZ_CLOUD_TOKEN=...
```

Then users on this instance never see Postiz Cloud: the tile skips the
credential window and the consent page and goes straight to the list of
TikTok channels connected in that cloud account; they pick one and are done.
No `pca_`/`pcs_` app is needed in this mode. Channels store a sentinel instead
of the token, so rotating `POSTIZ_CLOUD_TOKEN` in `.env` (+ backend and
orchestrator restart) takes effect without reconnecting anything.

To add another TikTok account to the cloud org, use **Get invite link** in
the channel picker (provider function `inviteLink` → cloud
`GET /public/v1/social/tiktok-business`): it returns the cloud's own one-hour
TikTok authorize URL bound to the cloud org. Send it to the TikTok owner —
they approve TikTok's consent screen, no Postiz account needed — then
**Refresh list** and pick the new channel. (The same link is what the 🔗
button next to *Add Channel* on platform.postiz.com produces.)

## Connecting the channel

Add channel → **TikTok (via Postiz Cloud)** → consent screen on
platform.postiz.com → pick which cloud TikTok channel to publish through. The
chosen cloud integration id is stored as the channel's `internalId`; the
`pos_` token is the channel token (it does not expire — revoke it under
Postiz Cloud → Settings → Approved Apps).

## Publishing

For each post the provider:

1. imports every attachment into the cloud media library via
   `POST /public/v1/upload-from-url` (the cloud only publishes media hosted on
   its own domain, so our upload URLs must be publicly reachable);
2. creates a `type: now` post on the cloud integration with the same TikTok
   settings (`__type` becomes the cloud channel's identifier);
3. returns `pending`; the post workflow polls `GET /public/v1/posts` until the
   cloud post is `PUBLISHED` (release URL copied back) or `ERROR` (the cloud's
   error message is surfaced on the post).

Rate limit: the cloud allows ~100 post creations per hour per account.

## Troubleshooting

- "Your Postiz Cloud account has no TikTok channel" — connect TikTok on
  platform.postiz.com first.
- "The TikTok channel is no longer connected in Postiz Cloud" — the cloud
  channel was removed/disabled; reconnect it there, then reconnect this
  channel (Preferences → Reconnect).
- Errors from TikTok itself (e.g. privacy level not allowed) are the cloud's
  post error, shown verbatim on the failed post.
