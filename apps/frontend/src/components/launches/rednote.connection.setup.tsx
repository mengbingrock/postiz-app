'use client';

import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

type SetupStatus = 'idle' | 'running' | 'success' | 'error';

type SetupResponse = {
  status?: SetupStatus;
  message?: string | string[];
  username?: string;
};

type Variable = {
  key: string;
  defaultValue?: string;
};

const responseError = (data: SetupResponse, fallback: string) =>
  Array.isArray(data.message)
    ? data.message.join(', ')
    : data.message || fallback;

export const RedNoteConnectionSetup: FC<{
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
  const [status, setStatus] = useState<SetupStatus>('idle');
  const [message, setMessage] = useState(
    'Postiz will install the verified tools for this server, then open RedNote login.'
  );
  const [connecting, setConnecting] = useState(false);

  const readStatus = useCallback(async () => {
    const response = await fetch('/integrations/rednote/login/status');
    const data = (await response.json()) as SetupResponse;
    if (!response.ok) {
      throw new Error(responseError(data, 'Unable to check login status.'));
    }
    setStatus(data.status || 'idle');
    setMessage(responseError(data, 'Waiting for RedNote login.'));
    return data.status;
  }, [fetch]);

  useEffect(() => {
    if (status !== 'running') {
      return;
    }
    const timer = window.setInterval(() => {
      readStatus().catch((error) => {
        setStatus('error');
        setMessage(
          error instanceof Error ? error.message : 'Login status check failed.'
        );
      });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [status, readStatus]);

  const startLogin = useCallback(async () => {
    setStatus('running');
    setMessage('Installing verified RedNote tools if needed…');
    try {
      const response = await fetch('/integrations/rednote/login/start', {
        method: 'POST',
        body: JSON.stringify(configuration),
      });
      const data = (await response.json()) as SetupResponse;
      if (!response.ok) {
        throw new Error(responseError(data, 'Unable to open RedNote login.'));
      }
      setStatus(data.status || 'running');
      setMessage(responseError(data, 'Complete login in the opened window.'));
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Unable to open RedNote login.'
      );
    }
  }, [configuration, fetch]);

  const startMcpAndConnect = useCallback(async () => {
    setConnecting(true);
    setMessage('Starting MCP and verifying the saved cookie…');
    try {
      const startResponse = await fetch('/integrations/rednote/mcp/start', {
        method: 'POST',
        body: JSON.stringify(configuration),
      });
      const startData = (await startResponse.json()) as SetupResponse;
      if (!startResponse.ok) {
        throw new Error(
          responseError(startData, 'MCP could not use the saved login cookie.')
        );
      }

      const stateResponse = await fetch(
        `/integrations/social/rednote${onboarding ? '?onboarding=true' : ''}`
      );
      const stateData = (await stateResponse.json()) as {
        url?: string;
        err?: boolean;
      };
      if (!stateResponse.ok || stateData.err || !stateData.url) {
        throw new Error('Postiz could not create the RedNote connection.');
      }

      modals.closeAll();
      gotoUrl(
        `/integrations/social/rednote?state=${stateData.url}&code=${Buffer.from(
          JSON.stringify(configuration)
        ).toString('base64')}${onboarding ? '&onboarding=true' : ''}`
      );
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Unable to connect RedNote.'
      );
      setConnecting(false);
    }
  }, [configuration, fetch, gotoUrl, modals, onboarding]);

  const statusColor =
    status === 'success'
      ? 'text-green-500'
      : status === 'error'
      ? 'text-red-500'
      : 'text-textColor/70';

  return (
    <div className="flex flex-col gap-[14px] pt-[10px] min-w-[420px] max-w-[520px]">
      <section className="rounded-[8px] border border-tableBorder p-[16px] flex flex-col gap-[10px]">
        <div className="flex items-center gap-[10px]">
          <div className="w-[28px] h-[28px] rounded-full bg-forth text-white flex items-center justify-center text-[14px]">
            1
          </div>
          <div>
            <div className="font-semibold">Log in and save the cookie</div>
            <div className="text-[12px] text-textColor/60">
              Postiz automatically installs the official tools for this server,
              then opens a visible login window on its desktop.
            </div>
          </div>
        </div>
        <Button
          type="button"
          onClick={startLogin}
          loading={status === 'running'}
        >
          {status === 'success'
            ? 'Log in with another account'
            : 'Install Tools & Open Login'}
        </Button>
      </section>

      <section className="rounded-[8px] border border-tableBorder p-[16px] flex flex-col gap-[10px]">
        <div className="flex items-center gap-[10px]">
          <div className="w-[28px] h-[28px] rounded-full bg-forth text-white flex items-center justify-center text-[14px]">
            2
          </div>
          <div>
            <div className="font-semibold">Start MCP and connect Postiz</div>
            <div className="text-[12px] text-textColor/60">
              MCP must verify the cookie saved in Step 1 before the channel is
              added.
            </div>
          </div>
        </div>
        <Button
          type="button"
          onClick={startMcpAndConnect}
          disabled={status !== 'success'}
          loading={connecting}
        >
          Start MCP & Connect
        </Button>
      </section>

      <div className={`text-[13px] ${statusColor}`} role="status">
        {message}
      </div>
    </div>
  );
};
