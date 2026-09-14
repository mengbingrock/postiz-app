'use client';

import { withContinueProvider } from '../with-continue-provider';

interface TiktokCloudItem {
  id: string;
  name: string;
  identifier: string;
  picture?: {
    data: {
      url: string;
    };
  };
}

interface TiktokCloudSelection {
  id: string;
}

export const TiktokCloudContinue = withContinueProvider<
  TiktokCloudItem,
  TiktokCloudSelection
>({
  endpoint: 'pages',
  swrKey: 'load-tiktok-cloud-channels',
  titleKey: 'select_tiktok_cloud_channel',
  titleDefault: 'Select the TikTok channel of your Postiz Cloud account:',
  emptyStateMessages: [
    {
      key: 'tiktok_cloud_no_channels_found',
      text: "We couldn't find a TikTok channel in your Postiz Cloud account.",
    },
    {
      key: 'tiktok_cloud_connect_first',
      text: 'Connect TikTok at platform.postiz.com first, then close this dialog and try again.',
    },
  ],
  getItemId: (item) => item.id,
  getSelectionValue: (item) => ({ id: item.id }),
  transformSaveData: (selection) => selection,
  isSelected: (item, selection) => selection?.id === item.id,
  renderItem: (item) => (
    <>
      <div className="flex justify-center">
        {item.picture?.data?.url ? (
          <img
            className="w-[80px] h-[80px] object-cover rounded-full"
            src={item.picture.data.url}
            alt={item.name}
          />
        ) : (
          <div className="w-[80px] h-[80px] bg-input rounded-full flex items-center justify-center text-[24px] font-semibold">
            {item.name?.slice(0, 1)?.toUpperCase() || 'T'}
          </div>
        )}
      </div>
      <div className="text-sm font-medium">{item.name}</div>
      <div className="text-[11px] text-textColor/60">
        {item.identifier === 'tiktok-business' ? 'TikTok Business' : 'TikTok'}
      </div>
    </>
  ),
});
