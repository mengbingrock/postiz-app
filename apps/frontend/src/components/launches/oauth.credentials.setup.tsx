'use client';

import React, { FC, useMemo, useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { object, string } from 'yup';
import { yupResolver } from '@hookform/resolvers/yup';
import copy from 'copy-to-clipboard';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Input } from '@gitroom/react/form/input';
import { Button } from '@gitroom/react/form/button';

export type OAuthCredentialSetupView = {
  clientIdLabel: string;
  clientSecretLabel: string;
  developerPortalUrl: string;
  documentationUrl: string;
  help: string[];
  scopes: string[];
  missing: string[];
  callbackPath?: string;
};

const schema = object({
  clientId: string()
    .trim()
    .min(3, 'Enter the Client ID from the provider')
    .max(512, 'Client ID is too long')
    .required('Client ID is required'),
  clientSecret: string()
    .trim()
    .min(8, 'Enter the Client Secret from the provider')
    .max(512, 'Client Secret is too long')
    .required('Client Secret is required'),
});

export const OAuthCredentialsSetup: FC<{
  identifier: string;
  providerName: string;
  setup: OAuthCredentialSetupView;
  onboarding?: boolean;
  redirectUrl?: string;
}> = ({ identifier, providerName, setup, onboarding, redirectUrl }) => {
  const fetch = useFetch();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const callbackUrl = `${origin}${
    setup.callbackPath || `/integrations/social/${identifier}`
  }`;
  const scopeText = useMemo(() => setup.scopes.join(', '), [setup.scopes]);
  const methods = useForm({
    mode: 'onChange',
    resolver: yupResolver(schema),
    defaultValues: { clientId: '', clientSecret: '' },
  });

  const submit = methods.handleSubmit(async (values) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(
        `/integrations/social/${identifier}/custom-oauth`,
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
          result.message || result.error || `Could not connect ${providerName}`
        );
      }
      window.location.href = result.url;
    } catch (connectError) {
      setError(
        connectError instanceof Error
          ? connectError.message
          : `Could not connect ${providerName}`
      );
      setLoading(false);
    }
  });

  return (
    <div className="flex max-h-[75vh] flex-col gap-[16px] overflow-y-auto pe-[4px] text-textColor">
      <div className="rounded-[8px] border border-amber-500/40 bg-amber-500/10 p-[16px]">
        <div className="mb-[6px] text-[16px] font-semibold">
          Set up {providerName}
        </div>
        <p className="text-[13px] leading-[20px] text-textColor/80">
          This Postiz server does not have {setup.missing.join(' and ')} set.
          Add credentials from an app you control to continue—no failed OAuth
          page is opened.
        </p>
      </div>

      <div className="rounded-[8px] border border-newTableBorder bg-newBgColorInner p-[16px]">
        <div className="mb-[10px] text-[14px] font-semibold">Setup guide</div>
        <ol className="flex list-decimal flex-col gap-[10px] ps-[20px] text-[13px] leading-[20px] text-textColor/85">
          <li>
            Open the{' '}
            <a
              href={setup.developerPortalUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              {providerName} developer portal
            </a>{' '}
            and create an OAuth application.
          </li>
          {setup.help.map((step) => (
            <li key={step}>{step}</li>
          ))}
          <li>
            Add this exact redirect or callback URL:
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
          {!!scopeText && (
            <li>
              Enable the permissions Postiz requests:
              <div className="mt-[6px] flex items-center gap-[8px] rounded-[6px] border border-newTableBorder bg-tableBorder/40 p-[8px]">
                <code className="min-w-0 flex-1 break-words text-[12px]">
                  {scopeText}
                </code>
                <button
                  type="button"
                  className="shrink-0 text-[12px] text-primary underline"
                  onClick={() => copy(scopeText)}
                >
                  Copy
                </button>
              </div>
            </li>
          )}
        </ol>
        <a
          href={setup.documentationUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-[12px] inline-block text-[13px] text-primary underline"
        >
          Open {providerName} OAuth documentation
        </a>
      </div>

      <FormProvider {...methods}>
        <form className="flex flex-col gap-[4px]" onSubmit={submit}>
          <Input
            label={setup.clientIdLabel}
            name="clientId"
            autoComplete="off"
          />
          <Input
            label={setup.clientSecretLabel}
            name="clientSecret"
            type="password"
            autoComplete="new-password"
          />
          <p className="mb-[8px] text-[12px] leading-[18px] text-textColor/65">
            Postiz sends the secret only to its backend. It is encrypted for the
            OAuth session and stored encrypted with the connected channel; it is
            never put in the browser URL or returned by the API.
          </p>
          {!!error && (
            <div className="mb-[8px] rounded-[6px] bg-red-500/10 p-[10px] text-[12px] text-red-400">
              {error}
            </div>
          )}
          <Button type="submit" loading={loading}>
            Continue to {providerName}
          </Button>
        </form>
      </FormProvider>
    </div>
  );
};
