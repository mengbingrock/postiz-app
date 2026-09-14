'use client';

import { FC, useCallback, useState } from 'react';
import copy from 'copy-to-clipboard';
import { Button } from '@gitroom/react/form/button';
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

// Lets the TikTok owner connect their account into the Postiz Cloud org from
// here, without anyone visiting platform.postiz.com: the link is the cloud's
// own one-hour invite link; after they authorize, "Refresh list" shows it.
const InviteLink: FC<{
  call: (name: string, data?: any) => Promise<any>;
  reload: () => void;
}> = ({ call, reload }) => {
  const [url, setUrl] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setCopied(false);
    try {
      const result = await call('inviteLink');
      if (!result?.url) {
        throw new Error(
          Array.isArray(result?.message)
            ? result.message.join(', ')
            : result?.message || 'Could not create the invite link.'
        );
      }
      setUrl(result.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the invite link.');
    } finally {
      setLoading(false);
    }
  }, [call]);

  return (
    <div className="w-full text-left text-[13px] leading-[20px] rounded-[8px] border border-tableBorder p-[12px] flex flex-col gap-[8px]">
      <div className="font-semibold text-[14px]">
        Add another TikTok account
      </div>
      <div className="text-textColor/70">
        Create an invite link and send it to the TikTok account owner. They
        authorize TikTok (no Postiz account needed); the channel then shows up
        here. The link is valid for one hour.
      </div>
      <div className="flex flex-wrap gap-[8px] items-center">
        <Button type="button" secondary loading={loading} onClick={generate}>
          {url ? 'New invite link' : 'Get invite link'}
        </Button>
        <Button type="button" secondary onClick={reload}>
          Refresh list
        </Button>
      </div>
      {url ? (
        <div className="flex flex-col gap-[6px]">
          <input
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full h-[36px] rounded-[6px] border border-newTableBorder bg-newBgColorInner px-[10px] text-[12px] text-textColor outline-none"
          />
          <div className="flex gap-[8px]">
            <Button
              type="button"
              onClick={() => {
                copy(url);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline self-center"
            >
              Open it myself
            </a>
          </div>
        </div>
      ) : null}
      {error ? <div className="text-red-500">{error}</div> : null}
    </div>
  );
};

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
      text: 'Use the invite link below to connect one, then refresh the list.',
    },
  ],
  getItemId: (item) => item.id,
  getSelectionValue: (item) => ({ id: item.id }),
  transformSaveData: (selection) => selection,
  isSelected: (item, selection) => selection?.id === item.id,
  renderExtra: ({ call, reload }) => <InviteLink call={call} reload={reload} />,
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
