'use client';

import React, { FC, useMemo, useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { object, string } from 'yup';
import { yupResolver } from '@hookform/resolvers/yup';
import copy from 'copy-to-clipboard';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Input } from '@gitroom/react/form/input';
import { Button } from '@gitroom/react/form/button';

const requestedPermissions = [
  'pages_show_list',
  'business_management',
  'pages_manage_posts',
  'pages_read_engagement',
];

const optionalPermissions = ['pages_manage_engagement', 'read_insights'];

const schema = object({
  clientId: string()
    .matches(/^\d{5,32}$/, 'Enter the numeric App ID from Meta')
    .required('App ID is required'),
  clientSecret: string()
    .trim()
    .min(16, 'Enter the App Secret from Meta')
    .max(256, 'App Secret is too long')
    .required('App Secret is required'),
});

export const FacebookConnectionSetup: FC<{
  onboarding?: boolean;
  redirectUrl?: string;
}> = ({ onboarding, redirectUrl }) => {
  const fetch = useFetch();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const callbackUrl = `${origin}/integrations/social/facebook`;
  const appDomain = typeof window === 'undefined' ? '' : window.location.host;
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
        '/integrations/social/facebook/custom-oauth',
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
          result.message || result.error || 'Could not start Meta authorization'
        );
      }
      window.location.href = result.url;
    } catch (connectError) {
      setError(
        connectError instanceof Error
          ? connectError.message
          : 'Could not start Meta authorization'
      );
      setLoading(false);
    }
  });

  return (
    <div className="flex max-h-[75vh] flex-col gap-[16px] overflow-y-auto pe-[4px] text-textColor">
      <div className="rounded-[8px] border border-newTableBorder bg-newBgColorInner p-[16px]">
        <div className="mb-[10px] text-[16px] font-semibold">
          Connect with your own Meta app
        </div>
        <p className="text-[13px] leading-[20px] text-textColor/80">
          Postiz uses the official Facebook Graph API. Create a Meta developer
          app that you control, grant it Page permissions, then enter its App ID
          and App Secret below.
        </p>
      </div>

      <ol className="flex list-decimal flex-col gap-[12px] ps-[22px] text-[13px] leading-[20px] text-textColor/85">
        <li>
          Open{' '}
          <a
            href="https://developers.facebook.com/apps/creation/"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline"
          >
            Meta for Developers
          </a>{' '}
          and create an app with the{' '}
          <strong>Manage everything on your Page</strong> use case.
        </li>
        <li>
          In <strong>App settings → Basic</strong>, set App Domains to{' '}
          <code className="break-all rounded bg-tableBorder px-[4px] py-[2px]">
            {appDomain}
          </code>{' '}
          and add a valid privacy-policy and user-data-deletion URL.
        </li>
        <li>
          In <strong>Facebook Login for Business → Settings</strong>, enable
          Client OAuth Login and Web OAuth Login. Add this exact Valid OAuth
          Redirect URI:
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
          In{' '}
          <strong>Use cases → Manage Pages → Permissions and features</strong>,
          add these permissions:
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
          <p className="mt-[6px] text-[12px] text-textColor/65">
            Optional after Meta review: {optionalPermissions.join(', ')} for
            comment management and analytics. They are not requested during the
            initial publishing connection.
          </p>
        </li>
        <li>
          While the app is unpublished, the Facebook account you connect must
          have an App role and must manage the Page. To connect accounts outside
          your app roles, complete Meta App Review, business verification and
          publish the app.
        </li>
      </ol>

      <FormProvider {...methods}>
        <form className="flex flex-col gap-[4px]" onSubmit={submit}>
          <Input label="Meta App ID" name="clientId" autoComplete="off" />
          <Input
            label="Meta App Secret"
            name="clientSecret"
            type="password"
            autoComplete="new-password"
          />
          <p className="mb-[8px] text-[12px] leading-[18px] text-textColor/65">
            The secret is sent only to your Postiz backend, encrypted during the
            OAuth flow, and stored encrypted with the connected channel. It is
            never added to the browser URL.
          </p>
          {!!error && (
            <div className="mb-[8px] rounded-[6px] bg-red-500/10 p-[10px] text-[12px] text-red-400">
              {error}
            </div>
          )}
          <Button type="submit" loading={loading}>
            Continue to Facebook
          </Button>
        </form>
      </FormProvider>
    </div>
  );
};
