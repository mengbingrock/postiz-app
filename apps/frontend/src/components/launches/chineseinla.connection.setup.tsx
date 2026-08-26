'use client';

import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import React, { FC, FormEvent, useMemo, useState } from 'react';

type Variable = {
  key: string;
  defaultValue?: string;
};

type LoginResponse = {
  success?: boolean;
  state?: string;
  message?: string | string[];
  screenshot?: string;
  attempts?: number;
};

const responseMessage = (data: LoginResponse, fallback: string) =>
  Array.isArray(data.message)
    ? data.message.join(', ')
    : data.message || fallback;

export const ChineseInLAConnectionSetup: FC<{
  variables: Variable[];
  gotoUrl(url: string): void;
  onboarding?: boolean;
}> = ({ variables, gotoUrl, onboarding }) => {
  const fetch = useFetch();
  const modals = useModals();
  const configuration = useMemo(
    () =>
      variables.reduce<Record<string, string>>((result, variable) => {
        if (variable.defaultValue) {
          result[variable.key] = variable.defaultValue;
        }
        return result;
      }, {}),
    [variables]
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState(
    'Enter the credentials for the ChineseInLA account you want Postiz to use.'
  );
  const [screenshot, setScreenshot] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submittedUsername = username.trim();
    if (!submittedUsername || !password) {
      setFailed(true);
      setMessage('Enter both your ChineseInLA username and password.');
      return;
    }

    const submittedPassword = password;
    setPassword('');
    setLoading(true);
    setFailed(false);
    setScreenshot(undefined);
    setMessage(
      'Starting the isolated headless browser and signing in to ChineseInLA…'
    );

    try {
      const response = await fetch('/integrations/chineseinla/login', {
        method: 'POST',
        body: JSON.stringify({
          ...configuration,
          username: submittedUsername,
          password: submittedPassword,
        }),
      });
      const data = (await response.json()) as LoginResponse;
      if (!response.ok) {
        throw new Error(
          responseMessage(data, 'Unable to sign in to ChineseInLA.')
        );
      }
      if (!data.success) {
        setFailed(true);
        setScreenshot(data.screenshot);
        setMessage(
          responseMessage(data, 'ChineseInLA did not complete login.')
        );
        return;
      }

      const credentials = {
        ...configuration,
        profileName: submittedUsername,
      };
      const stateResponse = await fetch(
        `/integrations/social/chineseinla${
          onboarding ? '?onboarding=true' : ''
        }`
      );
      const stateData = (await stateResponse.json()) as {
        url?: string;
        err?: boolean;
      };
      if (!stateResponse.ok || stateData.err || !stateData.url) {
        throw new Error('Postiz could not create the ChineseInLA channel.');
      }

      modals.closeAll();
      gotoUrl(
        `/integrations/social/chineseinla?state=${
          stateData.url
        }&code=${Buffer.from(JSON.stringify(credentials)).toString('base64')}${
          onboarding ? '&onboarding=true' : ''
        }`
      );
    } catch (error) {
      setFailed(true);
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to connect ChineseInLA.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      className="flex min-w-[420px] max-w-[520px] flex-col gap-[14px] pt-[10px]"
      onSubmit={connect}
    >
      <div className="rounded-[8px] border border-tableBorder p-[16px]">
        <div className="font-semibold">ChineseInLA account</div>
        <p className="mt-[4px] text-[12px] text-textColor/60">
          Postiz sends these credentials directly from its authenticated backend
          to the local MCP browser session. The password is not stored in the
          channel; only the resulting isolated browser cookie is kept.
        </p>
      </div>

      <label className="flex flex-col gap-[6px] text-[14px]">
        <span>Username, email, or phone</span>
        <input
          type="text"
          name="username"
          autoComplete="username"
          maxLength={40}
          required
          disabled={loading}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className="h-[42px] rounded-[8px] border border-newTableBorder bg-newBgColorInner px-[14px] text-textColor outline-none disabled:opacity-60"
        />
      </label>

      <label className="flex flex-col gap-[6px] text-[14px]">
        <span>Password</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          maxLength={32}
          required
          disabled={loading}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="h-[42px] rounded-[8px] border border-newTableBorder bg-newBgColorInner px-[14px] text-textColor outline-none disabled:opacity-60"
        />
      </label>

      {screenshot ? (
        <div className="rounded-[8px] border border-orange-500/40 bg-white p-[10px]">
          <img
            src={screenshot}
            alt="ChineseInLA login page requiring attention"
            className="max-h-[320px] w-full object-contain"
          />
        </div>
      ) : null}

      <p
        aria-live="polite"
        className={`text-[12px] ${
          failed ? 'text-red-500' : 'text-textColor/65'
        }`}
      >
        {message}
      </p>

      <Button type="submit" loading={loading} disabled={loading}>
        Connect ChineseInLA
      </Button>
    </form>
  );
};
