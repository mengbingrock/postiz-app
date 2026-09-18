'use client';

import { FC, useCallback, useState } from 'react';
import copy from 'copy-to-clipboard';
import { Button } from '@gitroom/react/form/button';
import { withContinueProvider } from '../with-continue-provider';

interface PostizCloudItem {
  id: string;
  name: string;
  identifier: string;
  picture?: {
    data: {
      url: string;
    };
  };
}

interface PostizCloudSelection {
  id: string;
}

// Lets the account owner connect their account into the Postiz Cloud org from
// here, without anyone visiting platform.postiz.com: the link is the cloud's
// own one-hour invite link; after they authorize, "Refresh list" shows it.
const InviteLink: FC<{
  channelLabel: string;
  call: (name: string, data?: any) => Promise<any>;
  reload: () => void;
}> = ({ channelLabel, call, reload }) => {
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
      setError(
        e instanceof Error ? e.message : 'Could not create the invite link.'
      );
    } finally {
      setLoading(false);
    }
  }, [call]);

  return (
    <div className="w-full text-left text-[13px] leading-[20px] rounded-[8px] border border-tableBorder p-[12px] flex flex-col gap-[8px]">
      <div className="font-semibold text-[14px]">
        Add another {channelLabel} account
      </div>
      <div className="text-textColor/70">
        Create an invite link and send it to the {channelLabel} account owner.
        They authorize {channelLabel} (no Postiz account needed); the channel
        then shows up here. The link is valid for one hour.
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
              className="self-center text-linkColor underline underline-offset-2"
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

// The account may already be connected in the user's own Postiz Cloud
// account rather than the shared one: their API key switches this channel to
// that account, and the list reloads from there.
const OwnCloudAccount: FC<{
  channelLabel: string;
  call: (name: string, data?: any) => Promise<any>;
  reload: () => void;
}> = ({ channelLabel, call, reload }) => {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<number>();

  const submit = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await call('useOwnCloud', { apiKey });
      if (typeof result?.channels !== 'number') {
        throw new Error(
          Array.isArray(result?.message)
            ? result.message.join(', ')
            : result?.message || 'Could not use this Postiz Cloud account.'
        );
      }
      setDone(result.channels);
      setApiKey('');
      reload();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not use this Postiz Cloud account.'
      );
    } finally {
      setLoading(false);
    }
  }, [apiKey, call, reload]);

  return (
    <div className="w-full text-left text-[13px] leading-[20px] rounded-[8px] border border-tableBorder p-[12px] flex flex-col gap-[8px]">
      <div className="font-semibold text-[14px]">
        Already connected {channelLabel} in your own Postiz Cloud account?
      </div>
      <div className="text-textColor/70">
        Paste that account&apos;s API key (platform.postiz.com → Settings →
        Developers → Access) and this channel will publish through it instead of
        the shared account.
      </div>
      {open ? (
        <div className="flex flex-col gap-[6px]">
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder="Postiz Cloud API key"
            onChange={(event) => setApiKey(event.target.value)}
            className="w-full h-[36px] rounded-[6px] border border-newTableBorder bg-newBgColorInner px-[10px] text-[12px] text-textColor outline-none"
          />
          <div className="flex gap-[8px]">
            <Button
              type="button"
              loading={loading}
              disabled={!apiKey.trim() || loading}
              onClick={submit}
            >
              Use this account
            </Button>
            <Button type="button" secondary onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" secondary onClick={() => setOpen(true)}>
            Use my own Postiz Cloud account
          </Button>
        </div>
      )}
      {typeof done === 'number' ? (
        <div className="text-textColor/70">
          Switched to your account: {done} {channelLabel} channel
          {done === 1 ? '' : 's'} found.
        </div>
      ) : null}
      {error ? <div className="text-red-500">{error}</div> : null}
    </div>
  );
};

export const createPostizCloudContinue = (options: {
  key: string; // used for swr key and i18n keys, e.g. "tiktok-cloud"
  channelLabel: string;
  kindLabel: (identifier: string) => string;
}) =>
  withContinueProvider<PostizCloudItem, PostizCloudSelection>({
    endpoint: 'pages',
    swrKey: `load-${options.key}-channels`,
    titleKey: `select_${options.key.replace(/-/g, '_')}_channel`,
    titleDefault: `Select the ${options.channelLabel} channel of your Postiz Cloud account:`,
    emptyStateMessages: [
      {
        key: `${options.key.replace(/-/g, '_')}_no_channels_found`,
        text: `We couldn't find a ${options.channelLabel} channel in your Postiz Cloud account.`,
      },
      {
        key: `${options.key.replace(/-/g, '_')}_connect_first`,
        text: 'Use the invite link below to connect one, or switch to your own Postiz Cloud account, then refresh the list.',
      },
    ],
    getItemId: (item) => item.id,
    getSelectionValue: (item) => ({ id: item.id }),
    transformSaveData: (selection) => selection,
    isSelected: (item, selection) => selection?.id === item.id,
    renderExtra: ({ call, reload }) => (
      <>
        <InviteLink
          channelLabel={options.channelLabel}
          call={call}
          reload={reload}
        />
        <OwnCloudAccount
          channelLabel={options.channelLabel}
          call={call}
          reload={reload}
        />
      </>
    ),
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
              {item.name?.slice(0, 1)?.toUpperCase() ||
                options.channelLabel.slice(0, 1)}
            </div>
          )}
        </div>
        <div className="text-sm font-medium">{item.name}</div>
        <div className="text-[11px] text-textColor/60">
          {options.kindLabel(item.identifier)}
        </div>
      </>
    ),
  });
