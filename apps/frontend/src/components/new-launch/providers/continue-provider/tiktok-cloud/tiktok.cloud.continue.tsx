'use client';

import { createPostizCloudContinue } from '../postiz-cloud/postiz.cloud.continue';

export const TiktokCloudContinue = createPostizCloudContinue({
  key: 'tiktok-cloud',
  channelLabel: 'TikTok',
  kindLabel: (identifier) =>
    identifier === 'tiktok-business' ? 'TikTok Business' : 'TikTok',
});
