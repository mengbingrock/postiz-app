# Video covers over MCP

The local Python MCP package is a bridge; tool schemas and publishing run on
the Postiz server. Deploy this server change and reload the client's tool list.
Installing another local bridge alone cannot repair the old URL-only schema.
This change does not connect or authorize a social account.

Upload the video and cover to Postiz first. Pass ONE media object:

```json
{"attachments":[{"path":"https://uploads.example/video.mp4","thumbnail":"https://uploads.example/cover.jpg"}]}
```

Legacy string URLs remain supported. For frame-based selection, use
`thumbnailTimestamp` in milliseconds instead of `thumbnail`; zero is valid.
Use uploaded JPEG/PNG images; LinkedIn/Facebook downloads are capped at 2 MiB,
have a timeout, check content signatures and use the existing SSRF-safe
dispatcher without forwarding credentials. No image conversion or cropping is
performed automatically. Platform aspect-ratio/account restrictions still apply.

## Connector behavior

| Platform/path | Cover implementation | Limits |
| --- | --- | --- |
| LinkedIn personal/Page, including own-app variants | Request thumbnail upload URL and upload image before finalizing video | One video; platform processing/permissions still apply |
| YouTube | Map media cover to existing settings.thumbnail and existing thumbnails.set flow | Account verification required where applicable; Shorts displays are not guaranteed by standard thumbnail API |
| Facebook Page video (/videos) | Send image bytes as multipart thumb with the original video upload | Not Stories; do not assume identical behavior for every Reel surface |
| Instagram, both login types | cover_url for custom image, otherwise thumb_offset for frame | Single Reel, not Stories/carousels |
| TikTok Direct Post | video_cover_timestamp_ms in post_info | Frame only, not independent image or inbox UPLOAD |
| TikTok Business | Existing custom_thumbnail_url or thumbnail_offset | Account/app access required; preserve zero offset |
| Pinterest | Adapt one video-cover object to existing video + cover provider input | Single video; legacy two-attachment input unchanged |
| Reddit | Pass existing media.thumbnail through | Provider/account restrictions still apply |
| X, Threads, Bluesky, Mastodon, Telegram, Discord, Google Business and other providers | Normal video behavior remains provider-specific; explicit cover requests fail before any batch creates | This is a connector limitation, not a claim that each platform API lacks cover support |

All explicit unsupported combinations fail before creating any post in the MCP
batch. Do not silently remove a cover to bypass the check. User must choose to
omit it or use a native workflow. Covers on comments and Stories are not
supported by this connector. `integrationSchema` includes cover rules.

Separate image and video attachments are NOT a portable cover convention.
Pinterest's second-image convention is handled internally for the new input.
Postiz's auto-generated media-library preview also is not the requested cover.

## Testing and rollout

- Offline policy tests: `tsx --test libraries/nestjs-libraries/src/chat/tools/video.cover.test.ts`.
- Mocked tool/provider contract tests: `node --test libraries/nestjs-libraries/src/chat/tools/video.cover.contract.test.cjs` (TypeScript and zod dependencies required).
- These execute actual changed methods with mocked HTTP/framework boundaries;
  they do not prove platform acceptance. Full application compilation and live
  publishing require the full deployment environment.
- After deployment, verify the new attachment schema, make an authorized draft
  per connected target and check saved metadata, then publish only after user
  approval. Verify cover on the actual platform (including feed/grid/watch
  surfaces) and save the post ID/result. No automatic replacement or deletion
  of existing published videos. Do not retry an uncertain publish as a new post.
- The currently inspected MCP account is TrueGrit, not Chase's organization.
  Chase's channel inventory and original failing payloads remain to be checked;
  this matrix describes connector paths, not his connected accounts.

## API references

- [LinkedIn video thumbnail upload](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api)
- [Meta official Page video SDK parameters: thumb is a file](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/page.py)
- [Meta official Instagram media SDK parameters: cover_url and thumb_offset](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/iguser.py)
- [TikTok Direct Post](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)
- [YouTube thumbnails.set](https://developers.google.com/youtube/v3/docs/thumbnails/set)

Validated against repository/API sources on 2026-09-18; no live publishing was performed.
