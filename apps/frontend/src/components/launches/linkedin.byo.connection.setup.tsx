'use client';

import React, { FC, useMemo, useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { object, string } from 'yup';
import { yupResolver } from '@hookform/resolvers/yup';
import copy from 'copy-to-clipboard';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Input } from '@gitroom/react/form/input';
import { Button } from '@gitroom/react/form/button';

const requestedPermissions = ['openid', 'profile', 'w_member_social'];

const schema = object({
  clientId: string()
    .matches(/^[A-Za-z0-9_-]{5,128}$/, 'Enter the Client ID from LinkedIn')
    .required('Client ID is required'),
  clientSecret: string()
    .trim()
    .min(8, 'Enter the Client Secret from LinkedIn')
    .max(512, 'Client Secret is too long')
    .required('Client Secret is required'),
});

export const LinkedinByoConnectionSetup: FC<{
  onboarding?: boolean;
  redirectUrl?: string;
}> = ({ onboarding, redirectUrl }) => {
  const fetch = useFetch();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const callbackUrl = `${origin}/integrations/social/linkedin-byo`;
  const methods = useForm({
    mode: 'onChange',
    resolver: yupResolver(schema),
    defaultValues: { clientId: '', clientSecret: '' },
  });
  const permissionText = useMemo(() => requestedPermissions.join(', '), []);

  const submit = methods.handleSubmit(async (values) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(
        '/integrations/social/linkedin-byo/custom-oauth',
        {
          method: 'POST',
          body: JSON.stringify({
            clientId: values.clientId,
            clientSecret: values.clientSecret,
            onboarding,
            redirectUrl,
          }),
        }
      );
      const result = await response.json();
      if (!response.ok || !result.url) {
        throw new Error(
          result.message ||
            result.error ||
            'Could not start LinkedIn authorization'
        );
      }
      window.location.href = result.url;
    } catch (connectError) {
      setError(
        connectError instanceof Error
          ? connectError.message
          : 'Could not start LinkedIn authorization'
      );
      setLoading(false);
    }
  });

  return (
    <div className="flex max-h-[75vh] flex-col gap-[16px] overflow-y-auto pe-[4px] text-textColor">
      <div className="rounded-[8px] border border-newTableBorder bg-newBgColorInner p-[16px]">
        <div className="mb-[10px] text-[16px] font-semibold">
          Connect a personal profile with your own LinkedIn app
        </div>
        <p className="text-[13px] leading-[20px] text-textColor/80">
          Each customer supplies a LinkedIn app they control. Its credentials
          are stored encrypted on that customer&apos;s connected channel; no
          shared Postiz app or hardcoded Client ID is used.
        </p>
      </div>

      <ol className="flex list-decimal flex-col gap-[12px] ps-[22px] text-[13px] leading-[20px] text-textColor/85">
        <li>
          Open{' '}
          <a
            href="https://www.linkedin.com/developers/apps"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline"
          >
            LinkedIn Developers
          </a>
          , create an app, and select a LinkedIn Page you manage as the app
          publisher. This association does not make Postiz publish to the Page.
        </li>
        <li>
          In <strong>Products</strong>, enable both{' '}
          <strong>Sign In with LinkedIn using OpenID Connect</strong> and{' '}
          <strong>Share on LinkedIn</strong>. These self-service products allow
          identity lookup and posting to the authorizing member&apos;s profile.
        </li>
        <li>
          In <strong>Auth → Authorized redirect URLs for your app</strong>, add
          this exact HTTPS callback:
          <div className="mt-[6px] flex items-center gap-[8px] rounded-[6px] border border-newTableBorder bg-tableBorder/40 p-[8px]">
            <code className="min-w-0 flex-1 break-all text-[12px]">
              {callbackUrl}
            </code>
            <button
              type="button"
              className="shrink-0 text-[12px] text-primary underline"
              onClick={() => copy(callbackUrl)}
            >
              Copy
            </button>
          </div>
        </li>
        <li>
          Confirm the app can request these OAuth permissions:
          <div className="mt-[6px] flex items-center gap-[8px] rounded-[6px] border border-newTableBorder bg-tableBorder/40 p-[8px]">
            <code className="min-w-0 flex-1 break-words text-[12px]">
              {permissionText}
            </code>
            <button
              type="button"
              className="shrink-0 text-[12px] text-primary underline"
              onClick={() => copy(permissionText)}
            >
              Copy
            </button>
          </div>
        </li>
        <li>
          Continue with the personal LinkedIn account that should author posts.
          The Page selected when the app was created is only the app publisher.
        </li>
      </ol>

      <FormProvider {...methods}>
        <form className="flex flex-col gap-[4px]" onSubmit={submit}>
          <Input
            label="LinkedIn Client ID"
            name="clientId"
            autoComplete="off"
          />
          <Input
            label="LinkedIn Client Secret"
            name="clientSecret"
            type="password"
            autoComplete="new-password"
          />
          <p className="mb-[8px] text-[12px] leading-[18px] text-textColor/65">
            The Client Secret is sent only to your authenticated Postiz backend,
            encrypted while OAuth is pending, and stored encrypted with this
            channel. It is never included in LinkedIn&apos;s authorization URL.
          </p>
          {!!error && (
            <div className="mb-[8px] rounded-[6px] bg-red-500/10 p-[10px] text-[12px] text-red-400">
              {error}
            </div>
          )}
          <Button type="submit" loading={loading}>
            Continue to LinkedIn
          </Button>
        </form>
      </FormProvider>
    </div>
  );
};
