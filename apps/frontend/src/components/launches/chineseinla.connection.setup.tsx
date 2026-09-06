'use client';

import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import React, {
  FC,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

type Variable = {
  key: string;
  defaultValue?: string;
};

type LoginResponse = {
  code?: string;
  success?: boolean;
  state?: string;
  message?: string | string[];
  screenshot?: string;
  attempts?: number;
};

type EgressDevice = {
  deviceId: string;
  connectedAt: string;
};

type EgressResponse = LoginResponse & {
  ok?: boolean;
  connectorOnline?: boolean;
  devices?: EgressDevice[];
  lease?: {
    deviceId: string;
    expiresAt: string;
  } | null;
};

type EgressState = 'checking' | 'online' | 'offline' | 'failed';

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
  const [egressState, setEgressState] = useState<EgressState>('checking');
  const [egressMessage, setEgressMessage] = useState(
    'Checking for a local Postiz connector…'
  );
  const [egressDevices, setEgressDevices] = useState<EgressDevice[]>([]);
  const [deviceId, setDeviceId] = useState('');

  const readEgressStatus = useCallback(async () => {
    setEgressState('checking');
    setEgressMessage('Checking for a local Postiz connector…');
    try {
      const response = await fetch('/integrations/chineseinla/egress/status');
      const data = (await response.json()) as EgressResponse;
      if (!response.ok) {
        throw new Error(
          responseMessage(data, 'Unable to check the local connector.')
        );
      }
      const devices = data.devices || [];
      setEgressDevices(devices);
      setDeviceId((current) =>
        devices.some((device) => device.deviceId === current)
          ? current
          : devices[0]?.deviceId || ''
      );
      if (data.connectorOnline && devices.length) {
        setEgressState('online');
        setEgressMessage(
          'Local connector available. Postiz will start and verify a 10-minute secure route when you connect.'
        );
      } else {
        setEgressState('offline');
        setEgressMessage(
          'Local connector is offline. Start `postiz-mcp connector`, then check again.'
        );
      }
    } catch (error) {
      setEgressState('failed');
      setEgressMessage(
        error instanceof Error
          ? error.message
          : 'Unable to check the local connector.'
      );
    }
  }, [fetch]);

  useEffect(() => {
    void readEgressStatus();
  }, [readEgressStatus]);

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
    setMessage('Starting and verifying the secure local route to ChineseInLA…');

    try {
      const egressResponse = await fetch(
        '/integrations/chineseinla/egress/ensure',
        {
          method: 'POST',
          body: JSON.stringify({ deviceId: deviceId || undefined }),
        }
      );
      const egressData = (await egressResponse.json()) as EgressResponse;
      if (!egressResponse.ok || !egressData.ok) {
        setEgressState('offline');
        throw new Error(
          responseMessage(
            egressData,
            'The local connector could not reach ChineseInLA.'
          )
        );
      }
      const activeDeviceId = egressData.lease?.deviceId || deviceId;
      if (activeDeviceId) setDeviceId(activeDeviceId);
      setEgressState('online');
      setEgressMessage(
        `Secure route verified${
          activeDeviceId ? ` through ${activeDeviceId}` : ''
        }. It will close automatically after login.`
      );
      setMessage(
        'Starting the isolated headless browser and signing in to ChineseInLA…'
      );

      const response = await fetch('/integrations/chineseinla/login', {
        method: 'POST',
        body: JSON.stringify({
          ...configuration,
          username: submittedUsername,
          password: submittedPassword,
          deviceId: activeDeviceId || undefined,
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
      if (!data.code) {
        throw new Error(
          'Postiz did not return the isolated ChineseInLA connection credential.'
        );
      }
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
        `/integrations/social/chineseinla?state=${encodeURIComponent(
          stateData.url
        )}&code=${encodeURIComponent(data.code)}${
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
        <div className="flex items-center justify-between gap-[12px]">
          <div className="font-semibold">ChineseInLA account</div>
          <button
            type="button"
            disabled={loading || egressState === 'checking'}
            onClick={() => void readEgressStatus()}
            className="text-[12px] text-primary disabled:opacity-50"
          >
            {egressState === 'checking' ? 'Checking…' : 'Check again'}
          </button>
        </div>
        <p className="mt-[4px] text-[12px] text-textColor/60">
          Postiz sends these credentials directly from its authenticated backend
          to the local MCP browser session. The password is not stored in the
          channel; only the resulting isolated browser cookie is kept.
        </p>
        <p
          className={`mt-[8px] text-[12px] ${
            egressState === 'offline' || egressState === 'failed'
              ? 'text-red-500'
              : 'text-textColor/65'
          }`}
        >
          {egressMessage}
        </p>
        {egressDevices.length > 1 ? (
          <label className="mt-[10px] flex flex-col gap-[4px] text-[12px]">
            <span>Local connector</span>
            <select
              value={deviceId}
              disabled={loading}
              onChange={(event) => setDeviceId(event.target.value)}
              className="h-[36px] rounded-[6px] border border-newTableBorder bg-newBgColorInner px-[10px] text-textColor outline-none"
            >
              {egressDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.deviceId}
                </option>
              ))}
            </select>
          </label>
        ) : null}
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
