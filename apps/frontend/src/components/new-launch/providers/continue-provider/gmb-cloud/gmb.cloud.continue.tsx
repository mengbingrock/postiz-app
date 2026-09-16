'use client';

import { createPostizCloudContinue } from '../postiz-cloud/postiz.cloud.continue';

export const GmbCloudContinue = createPostizCloudContinue({
  key: 'gmb-cloud',
  channelLabel: 'Google Business Profile',
  kindLabel: () => 'Google Business Profile location',
});
