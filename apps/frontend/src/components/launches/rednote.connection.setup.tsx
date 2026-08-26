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
  qrCode?: string;
  expiresAt?: string;
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
    'Postiz will start a private headless browser and show its Xiaohongshu login QR code here.'
  );
  const [qrCode, setQrCode] = useState<string>();
  const [expiresAt, setExpiresAt] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const readStatus = useCallback(async () => {
    const response = await fetch('/integrations/rednote/login/status');
    const data = (await response.json()) as SetupResponse;
    if (!response.ok) {
      throw new Error(responseError(data, 'Unable to check login status.'));
    }
    setStatus(data.status || 'idle');
    setMessage(responseError(data, 'Waiting for RedNote login.'));
    setQrCode(data.qrCode);
    setExpiresAt(data.expiresAt);
    return data.status;
  }, [fetch]);

  useEffect(() => {
    if (status !== 'running') {
      return;
    }
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      try {
        await readStatus();
      } catch (error) {
        setStatus('error');
        setMessage(
          error instanceof Error ? error.message : 'Login status check failed.'
        );
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(poll, 3000);
        }
      }
    };
    timer = window.setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [status, readStatus]);

  const startLogin = useCallback(async () => {
    setStarting(true);
    setStatus('running');
    setQrCode(undefined);
    setExpiresAt(undefined);
    setMessage('Installing verified RedNote tools if needed…');
    try {
      const response = await fetch('/integrations/rednote/login/start', {
        method: 'POST',
        body: JSON.stringify(configuration),
      });
      const data = (await response.json()) as SetupResponse;
      if (!response.ok) {
        throw new Error(
          responseError(data, 'Unable to create the RedNote login QR code.')
        );
      }
      setStatus(data.status || 'running');
      setMessage(responseError(data, 'Scan the Xiaohongshu login QR code.'));
      setQrCode(data.qrCode);
      setExpiresAt(data.expiresAt);
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to create the RedNote login QR code.'
      );
    } finally {
      setStarting(false);
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
              Chromium stays headless on the server. Scan the QR code below with
              the Xiaohongshu mobile app and approve the login.
            </div>
          </div>
        </div>
        {qrCode ? (
          <div className="flex flex-col items-center gap-[8px] rounded-[8px] bg-white p-[14px]">
            <img
              src={qrCode}
              alt="Xiaohongshu login QR code"
              width={260}
              height={260}
              className="h-[260px] w-[260px] object-contain"
            />
            <div className="text-center text-[12px] text-black/60">
              {expiresAt
                ? `Valid until ${new Date(expiresAt).toLocaleTimeString()}`
                : 'This QR code is valid for about four minutes.'}
            </div>
          </div>
        ) : null}
        <Button
          type="button"
          onClick={startLogin}
          loading={starting}
          disabled={starting || connecting}
        >
          {status === 'running'
            ? 'Request a New QR Code'
            : status === 'success'
            ? 'Log in with Another Account'
            : 'Get Xiaohongshu QR Code'}
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
              After the scan succeeds, Postiz verifies the cookie saved by the
              headless browser before adding the channel.
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
