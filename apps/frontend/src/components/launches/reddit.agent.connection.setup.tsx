'use client';

import React, {
  FC,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { RedditAgentBrowserStream } from '@gitroom/frontend/components/launches/reddit.agent.browser.stream';

type SetupStatus = 'idle' | 'running' | 'success' | 'error';
type LoginMethod =
  | 'password'
  | 'google'
  | 'apple'
  | 'phone'
  | 'email_link'
  | 'sso';
type LoginState =
  | 'starting_browser'
  | 'submitting_credentials'
  | 'external_login_in_progress'
  | 'two_factor_required'
  | 'submitting_two_factor'
  | 'challenge_required'
  | 'authenticated'
  | 'invalid_credentials'
  | 'failed';

type AgentUi = {
  view: 'progress' | 'otp' | 'manual' | 'complete' | 'error';
  tone: 'neutral' | 'warning' | 'success' | 'danger';
  title: string;
  message: string;
  primaryAction: 'none' | 'submit_otp' | 'restart' | 'connect';
  source: 'agent' | 'fallback';
  authMode: 'api_key' | 'chatgpt_subscription' | 'fallback';
};

type SetupResponse = {
  status?: SetupStatus;
  message?: string | string[];
  loginState?: LoginState;
  username?: string;
  browserName?: string;
  connectionCode?: string;
  viewerPath?: string;
  remote?: boolean;
  otpRequired?: boolean;
  agentEnabled?: boolean;
  agentUi?: AgentUi;
};

type Variable = { key: string; defaultValue?: string };

const loginMethods: Array<{
  id: LoginMethod;
  label: string;
  description: string;
  action: string;
}> = [
  {
    id: 'password',
    label: 'Email or username',
    description: 'Use your Reddit password',
    action: 'Log in to Reddit',
  },
  {
    id: 'google',
    label: 'Google',
    description: 'Continue in the browser',
    action: 'Continue with Google',
  },
  {
    id: 'apple',
    label: 'Apple',
    description: 'Continue in the browser',
    action: 'Continue with Apple',
  },
  {
    id: 'phone',
    label: 'Phone number',
    description: 'Available in eligible regions',
    action: 'Continue with Phone Number',
  },
  {
    id: 'email_link',
    label: 'Email one-time link',
    description: 'Open the link Reddit emails you',
    action: 'Email me a one-time link',
  },
  {
    id: 'sso',
    label: 'SSO',
    description: 'Continue with organization SSO',
    action: 'Continue with SSO',
  },
];

const responseError = (data: SetupResponse, fallback: string) =>
  Array.isArray(data.message)
    ? data.message.join(', ')
    : data.message || fallback;

export const RedditAgentConnectionSetup: FC<{
  variables: Variable[];
  gotoUrl(url: string): void;
  onboarding?: boolean;
}> = ({ variables, gotoUrl, onboarding }) => {
  const fetch = useFetch();
  const modals = useModals();
  const defaultProfileName = useMemo(
    () =>
      variables.find((variable) => variable.key === 'profileName')
        ?.defaultValue || 'Reddit Browser Account',
    [variables]
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginMethod, setLoginMethod] = useState<LoginMethod>('password');
  const [profileName, setProfileName] = useState(defaultProfileName);
  const [otpCode, setOtpCode] = useState('');
  const [status, setStatus] = useState<SetupStatus>('idle');
  const [loginState, setLoginState] = useState<LoginState>();
  const [message, setMessage] = useState(
    'Postiz will sign in through a private Chrome or Chromium profile and keep that profile for publishing.'
  );
  const [browserName, setBrowserName] = useState<string>();
  const [viewerPath, setViewerPath] = useState<string>();
  const [remote, setRemote] = useState(false);
  const [connectionCode, setConnectionCode] = useState<string>();
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [agentUi, setAgentUi] = useState<AgentUi>();
  const [starting, setStarting] = useState(false);
  const [submittingOtp, setSubmittingOtp] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const activeLogin = useRef(false);
  const loginWindow = useRef<Window | null>(null);

  const applyStatus = useCallback((data: SetupResponse) => {
    const nextStatus = data.status || 'idle';
    setStatus(nextStatus);
    activeLogin.current = nextStatus === 'running';
    setLoginState(data.loginState);
    setMessage(responseError(data, 'Waiting for Reddit login.'));
    setBrowserName(data.browserName);
    setViewerPath(data.viewerPath);
    setRemote(Boolean(data.remote));
    setConnectionCode(data.connectionCode);
    setAgentEnabled(Boolean(data.agentEnabled));
    setAgentUi(data.agentUi);
    if (nextStatus === 'success' || nextStatus === 'error') {
      loginWindow.current?.close();
      loginWindow.current = null;
    }
    if (!data.otpRequired) setOtpCode('');
  }, []);

  useEffect(
    () => () => {
      if (!activeLogin.current) return;
      activeLogin.current = false;
      loginWindow.current?.close();
      loginWindow.current = null;
      void fetch('/integrations/reddit-agent/login/cancel', {
        method: 'POST',
        body: '{}',
      });
    },
    [fetch]
  );

  const readStatus = useCallback(async () => {
    const response = await fetch('/integrations/reddit-agent/login/status');
    const data = (await response.json()) as SetupResponse;
    if (!response.ok) {
      throw new Error(responseError(data, 'Unable to check Reddit login.'));
    }
    applyStatus(data);
  }, [applyStatus, fetch]);

  useEffect(() => {
    if (status !== 'running') return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      try {
        await readStatus();
      } catch (error) {
        setStatus('error');
        setMessage(
          error instanceof Error ? error.message : 'Reddit login check failed.'
        );
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 2500);
      }
    };
    timer = window.setTimeout(poll, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [readStatus, status]);

  const startLogin = useCallback(async () => {
    if (loginMethod === 'password' && (!username.trim() || !password)) {
      setMessage('Enter your Reddit email or username and password.');
      return;
    }
    setStarting(true);
    activeLogin.current = true;
    setStatus('running');
    setLoginState('starting_browser');
    setConnectionCode(undefined);
    setViewerPath(undefined);
    setAgentUi(undefined);
    setMessage('Starting a private Chrome or Chromium profile…');
    try {
      const response = await fetch('/integrations/reddit-agent/login/start', {
        method: 'POST',
        body: JSON.stringify({
          method: loginMethod,
          ...(loginMethod === 'password'
            ? { username: username.trim(), password }
            : {}),
          profileName:
            profileName.trim() ||
            username.trim() ||
            `Reddit ${
              loginMethods.find(({ id }) => id === loginMethod)?.label
            }`,
        }),
      });
      const data = (await response.json()) as SetupResponse;
      if (!response.ok) {
        throw new Error(responseError(data, 'Unable to start Reddit login.'));
      }
      applyStatus(data);
      if (data.viewerPath && loginWindow.current) {
        loginWindow.current.location.replace(data.viewerPath);
      } else if (!data.viewerPath && loginWindow.current) {
        loginWindow.current.close();
        loginWindow.current = null;
      }
    } catch (error) {
      activeLogin.current = false;
      loginWindow.current?.close();
      loginWindow.current = null;
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Unable to start Reddit login.'
      );
    } finally {
      setPassword('');
      setStarting(false);
    }
  }, [applyStatus, fetch, loginMethod, password, profileName, username]);

  const openLoginBrowser = useCallback(() => {
    if (!viewerPath) return;
    loginWindow.current = window.open(
      viewerPath,
      'postiz-reddit-agent-login',
      'popup,width=1280,height=900,noopener,noreferrer'
    );
  }, [viewerPath]);

  const submitOtp = useCallback(async () => {
    if (!/^\d{6}$/.test(otpCode)) {
      setMessage('Enter the current six-digit Reddit authenticator code.');
      return;
    }
    const code = otpCode;
    setOtpCode('');
    setSubmittingOtp(true);
    try {
      const response = await fetch('/integrations/reddit-agent/login/otp', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      const data = (await response.json()) as SetupResponse;
      if (!response.ok) {
        throw new Error(
          responseError(data, 'Unable to submit the Reddit verification code.')
        );
      }
      applyStatus(data);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to submit the Reddit verification code.'
      );
    } finally {
      setSubmittingOtp(false);
    }
  }, [applyStatus, fetch, otpCode]);

  const connect = useCallback(async () => {
    if (!connectionCode) return;
    setConnecting(true);
    try {
      const stateResponse = await fetch(
        `/integrations/social/reddit-agent${
          onboarding ? '?onboarding=true' : ''
        }`
      );
      const stateData = (await stateResponse.json()) as {
        url?: string;
        err?: boolean;
      };
      if (!stateResponse.ok || stateData.err || !stateData.url) {
        throw new Error('Postiz could not create the Reddit Agent channel.');
      }
      modals.closeAll();
      gotoUrl(
        `/integrations/social/reddit-agent?state=${
          stateData.url
        }&code=${connectionCode}${onboarding ? '&onboarding=true' : ''}`
      );
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to connect the Reddit Agent channel.'
      );
      setConnecting(false);
    }
  }, [connectionCode, fetch, gotoUrl, modals, onboarding]);

  const agentToneClass =
    agentUi?.tone === 'success'
      ? 'border-green-500/40 bg-green-500/10'
      : agentUi?.tone === 'danger'
      ? 'border-red-500/40 bg-red-500/10'
      : agentUi?.tone === 'warning'
      ? 'border-orange-500/40 bg-orange-500/10'
      : 'border-tableBorder bg-newBgColorInner';
  const embeddedViewer = status === 'running' && Boolean(viewerPath);

  return (
    <div
      className={`flex min-w-[420px] flex-col gap-[14px] pt-[10px] ${
        embeddedViewer
          ? 'w-[min(900px,calc(100vw-48px))] max-w-[900px]'
          : 'max-w-[520px]'
      }`}
    >
      <section className="flex flex-col gap-[10px] rounded-[8px] border border-tableBorder p-[16px]">
        <div>
          <div className="font-semibold">1. Log in with a private browser</div>
          <div className="text-[12px] text-textColor/60">
            Choose any method shown on Reddit’s login page. Third-party, phone,
            email-link, and SSO credentials stay in the opened browser. A Reddit
            password is kept only in volatile memory until submitted, then
            cleared.
          </div>
        </div>

        {agentUi ? (
          <div
            className={`rounded-[8px] border p-[12px] ${agentToneClass}`}
            data-testid="reddit-login-agent-view"
          >
            <div className="flex items-center justify-between gap-[12px]">
              <div className="text-[13px] font-semibold">{agentUi.title}</div>
              <div className="shrink-0 rounded-full border border-tableBorder px-[8px] py-[2px] text-[10px] text-textColor/60">
                {agentEnabled && agentUi.source === 'agent'
                  ? agentUi.authMode === 'chatgpt_subscription'
                    ? 'Subscription agent'
                    : 'Login agent'
                  : 'Safe fallback'}
              </div>
            </div>
            <div className="mt-[4px] text-[12px] text-textColor/70">
              {agentUi.message}
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-[6px]">
          <div className="text-[12px]">Login method</div>
          <div className="grid grid-cols-2 gap-[8px]">
            {loginMethods.map((method) => (
              <button
                key={method.id}
                type="button"
                disabled={status === 'running' || starting}
                aria-pressed={loginMethod === method.id}
                onClick={() => setLoginMethod(method.id)}
                className={`rounded-[8px] border p-[10px] text-left transition disabled:opacity-60 ${
                  loginMethod === method.id
                    ? 'border-primary bg-primary/10'
                    : 'border-newTableBorder bg-newBgColorInner hover:border-textColor/30'
                }`}
              >
                <div className="text-[13px] font-semibold">{method.label}</div>
                <div className="text-[10px] text-textColor/60">
                  {method.description}
                </div>
              </button>
            ))}
          </div>
        </div>

        {loginMethod === 'password' ? (
          <>
            <label className="flex flex-col gap-[4px] text-[12px]">
              Reddit email or username
              <input
                value={username}
                autoComplete="username"
                disabled={status === 'running' || starting}
                onChange={(event) => setUsername(event.target.value)}
                className="h-[42px] rounded-[8px] border border-newTableBorder bg-newBgColorInner px-[14px] text-[14px] text-textColor outline-none disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-[4px] text-[12px]">
              Reddit password
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                disabled={status === 'running' || starting}
                onChange={(event) => setPassword(event.target.value)}
                className="h-[42px] rounded-[8px] border border-newTableBorder bg-newBgColorInner px-[14px] text-[14px] text-textColor outline-none disabled:opacity-60"
              />
            </label>
          </>
        ) : (
          <div className="rounded-[8px] border border-newTableBorder bg-newBgColorInner p-[10px] text-[11px] text-textColor/60">
            Postiz will select “
            {loginMethods.find(({ id }) => id === loginMethod)?.action}” on
            Reddit. Finish the prompts in the interactive browser stream that
            appears below. Postiz never asks for or stores those credentials.
            Google or another identity provider may require you to use “Open
            separately.”
          </div>
        )}
        <label className="flex flex-col gap-[4px] text-[12px]">
          Channel label
          <input
            value={profileName}
            disabled={status === 'running' || starting}
            onChange={(event) => setProfileName(event.target.value)}
            className="h-[42px] rounded-[8px] border border-newTableBorder bg-newBgColorInner px-[14px] text-[14px] text-textColor outline-none disabled:opacity-60"
          />
        </label>

        {loginState === 'two_factor_required' ? (
          <form
            className="flex flex-col gap-[8px] rounded-[8px] border border-orange-500/40 bg-orange-500/10 p-[12px]"
            onSubmit={(event) => {
              event.preventDefault();
              void submitOtp();
            }}
          >
            <div className="text-[12px] text-textColor/70">
              Enter the six-digit authenticator code. Postiz does not save it.
            </div>
            <input
              value={otpCode}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              onChange={(event) =>
                setOtpCode(event.target.value.replace(/\D/g, '').slice(0, 6))
              }
              className="h-[42px] rounded-[8px] border border-newTableBorder bg-newBgColorInner px-[16px] text-center text-[20px] tracking-[0.35em] text-textColor outline-none"
            />
            <Button
              type="submit"
              loading={submittingOtp}
              disabled={otpCode.length !== 6 || submittingOtp}
            >
              Submit Code
            </Button>
          </form>
        ) : null}

        <Button
          type="button"
          onClick={startLogin}
          loading={starting}
          disabled={starting || connecting || status === 'running'}
        >
          {status === 'running'
            ? 'Browser Login Active'
            : status === 'success'
            ? 'Log in with Another Account'
            : agentUi?.primaryAction === 'restart'
            ? 'Start New Login'
            : loginMethods.find(({ id }) => id === loginMethod)?.action}
        </Button>
        <div className="text-[11px] text-textColor/60">
          {browserName ? `Browser: ${browserName}. ` : ''}
          {message}
        </div>
        {embeddedViewer && viewerPath ? (
          <div className="overflow-hidden rounded-[10px] border border-newTableBorder bg-black">
            <div className="flex items-center justify-between gap-[12px] border-b border-newTableBorder bg-newBgColorInner px-[12px] py-[8px]">
              <div>
                <div className="text-[12px] font-semibold">
                  Secure Reddit login browser
                </div>
                <div className="text-[10px] text-textColor/60">
                  Interactive Chrome screencast. The browser closes after login.
                </div>
              </div>
              <button
                type="button"
                className="text-[11px] text-primary hover:underline"
                onClick={openLoginBrowser}
              >
                Open separately
              </button>
            </div>
            <RedditAgentBrowserStream viewerPath={viewerPath} />
          </div>
        ) : null}
        {status === 'running' && remote && viewerPath ? (
          embeddedViewer ? null : (
            <Button type="button" onClick={openLoginBrowser} secondary>
              Open Secure Login Browser
            </Button>
          )
        ) : null}
      </section>

      <section className="flex flex-col gap-[10px] rounded-[8px] border border-tableBorder p-[16px]">
        <div>
          <div className="font-semibold">2. Save the channel</div>
          <div className="text-[12px] text-textColor/60">
            {remote
              ? 'Future posts load only the encrypted Reddit session into a clean publishing browser. The temporary cloud browser is destroyed after login.'
              : 'Future Reddit Agent posts reuse this exact local browser profile and its authenticated cookies.'}
          </div>
        </div>
        <Button
          type="button"
          onClick={connect}
          loading={connecting}
          disabled={status !== 'success' || !connectionCode || connecting}
        >
          Connect Reddit Agent
        </Button>
      </section>
    </div>
  );
};
