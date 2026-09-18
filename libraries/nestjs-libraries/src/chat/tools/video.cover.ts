// Keep platform adaptation separate from MCP transport and run it before any
// post in the batch is created. A cover is metadata, not a second attachment.
export type CoverMedia = {
  path: string;
  thumbnail?: string;
  thumbnailTimestamp?: number;
};
export type Attachment = string | CoverMedia;
const video = (path: string) =>
  /\.(mp4|mov|mpeg|mpg)$/i.test(path.split(/[?#]/)[0]);
const imagePlatforms = new Set([
  'linkedin',
  'linkedin-page',
  'linkedin-byo',
  'linkedin-page-byo',
  'youtube',
  'facebook',
  'instagram',
  'instagram-standalone',
  'tiktok-business',
  'pinterest',
  'reddit',
]);
const framePlatforms = new Set([
  'instagram',
  'instagram-standalone',
  'tiktok',
  'tiktok-business',
]);

export function videoCoverRules(provider: string) {
  return `Video covers through MCP: separate image ${
    imagePlatforms.has(provider)
      ? 'supported'
      : 'not supported by this connector'
  }; frame timestamp ${
    framePlatforms.has(provider)
      ? 'supported (milliseconds)'
      : 'not supported by this connector'
  }. Attach ONE {path: videoUrl, thumbnail: uploadedJpegOrPngUrl} or {path: videoUrl, thumbnailTimestamp: milliseconds}. Do not add the cover as another attachment. Stories and comment covers are not supported; Instagram requires a single Reel; TikTok frame selection requires DIRECT_POST. YouTube account verification and format restrictions (including Shorts) still apply. Verify the final platform display; a Postiz preview is not proof.`;
}

export function prepareVideoCovers(
  provider: string,
  posts: { content: string; attachments: Attachment[] }[],
  settings: Record<string, any>
) {
  const nextSettings = { ...settings };
  const value = posts.map((post, index) => {
    const media = post.attachments.map((a) =>
      typeof a === 'string' ? { path: a } : { ...a }
    );
    for (const item of media) {
      const hasFrame = item.thumbnailTimestamp !== undefined;
      if (!item.thumbnail && !hasFrame) continue;
      if (!video(item.path))
        throw new Error('Video cover metadata requires a video attachment.');
      if (item.thumbnail && hasFrame)
        throw new Error('Choose a cover image or a video frame, not both.');
      if (
        hasFrame &&
        (!Number.isInteger(item.thumbnailTimestamp) ||
          item.thumbnailTimestamp! < 0 ||
          item.thumbnailTimestamp! > 2147483647)
      ) {
        throw new Error(
          'Cover frame must be a non-negative int32 timestamp in milliseconds.'
        );
      }
      if (index > 0)
        throw new Error(
          'Video covers on comments are not supported by this connector.'
        );
      if (settings.post_type === 'story')
        throw new Error(
          'Custom video covers are not supported for Stories by this connector.'
        );
      if (item.thumbnail && !imagePlatforms.has(provider))
        throw new Error(
          `${provider}: custom cover images are not supported by this connector; do not publish without user approval to omit the cover.`
        );
      if (hasFrame && !framePlatforms.has(provider))
        throw new Error(
          `${provider}: selecting a cover frame is not supported by this connector; use a cover image where supported.`
        );
      if (provider === 'tiktok' && settings.content_posting_method === 'UPLOAD')
        throw new Error(
          'TikTok inbox upload cannot set the published cover; complete it in TikTok or choose DIRECT_POST.'
        );
      if (
        (provider === 'instagram' || provider === 'instagram-standalone') &&
        media.length !== 1
      )
        throw new Error(
          'Instagram custom covers require a single Reel, not a carousel.'
        );
      if (provider === 'youtube' && item.thumbnail) {
        if (
          nextSettings.thumbnail?.path &&
          nextSettings.thumbnail.path !== item.thumbnail
        )
          throw new Error(
            'Conflicting YouTube cover images in settings and attachment.'
          );
        nextSettings.thumbnail = { id: 'video-cover', path: item.thumbnail };
      }
    }
    // Pinterest's provider expects a dedicated second image; adapt only here.
    if (provider === 'pinterest' && media[0]?.thumbnail) {
      if (media.length !== 1)
        throw new Error(
          'Use one Pinterest video with its cover, not additional attachments.'
        );
      media.push({ path: media[0].thumbnail });
    }
    return { content: post.content, image: media };
  });
  return { value, settings: nextSettings };
}
