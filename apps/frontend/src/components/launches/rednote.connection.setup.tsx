'use client';

import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

type SetupStatus = 'idle' | 'running' | 'success' | 'error';
type LoginState =
  | 'waiting_for_scan'
  | 'qr_scanned'
  | 'otp_required'
  | 'submitting_otp'
  | 'otp_submitted'
  | 'captcha_required'
  | 'authenticated'
  | 'failed'
  | 'expired'
  | 'cancelled';

type SetupResponse = {
  code?: string;
  status?: SetupStatus;
  message?: string | string[];
  username?: string;
  qrCode?: string;
  expiresAt?: string;
  loginState?: LoginState;
  otpRequired?: boolean;
  otpAttempts?: number;
  otpMaxAttempts?: number;
  agentEnabled?: boolean;
  agentUi?: AgentUi;
  viewUrl?: string;
};

type AgentUi = {
  view: 'qr' | 'waiting' | 'otp' | 'manual' | 'complete' | 'error';
  tone: 'neutral' | 'warning' | 'success' | 'danger';
  title: string;
  message: string;
  primaryAction: 'none' | 'submit_otp' | 'restart' | 'connect';
  source: 'agent' | 'fallback';
  authMode: 'api_key' | 'chatgpt_subscription' | 'fallback';
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
  const [loginState, setLoginState] = useState<LoginState>();
  const [otpCode, setOtpCode] = useState('');
  const [otpAttempts, setOtpAttempts] = useState(0);
  const [otpMaxAttempts, setOtpMaxAttempts] = useState(3);
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [agentUi, setAgentUi] = useState<AgentUi>();
  const [starting, setStarting] = useState(false);
  const [startingVisible, setStartingVisible] = useState(false);
  const [viewUrl, setViewUrl] = useState<string>();
  const [submittingOtp, setSubmittingOtp] = useState(false);
  const [resendingOtp, setResendingOtp] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown <= 0) {
      return;
    }
    const timer = window.setTimeout(
      () => setResendCooldown((value) => value - 1),
      1000
    );
    return () => window.clearTimeout(timer);
  }, [resendCooldown]);

  const resendOtp = useCallback(async () => {
    setResendingOtp(true);
    try {
      const response = await fetch('/integrations/rednote/login/resend', {
        method: 'POST',
      });
      const data = (await response.json()) as SetupResponse;
      if (!response.ok) {
        throw new Error(
          responseError(data, 'Unable to resend the verification code.')
        );
      }
      setMessage(
        responseError(data, 'Verification code resent. Check your phone.')
      );
      setResendCooldown(60);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to resend the verification code.'
      );
    } finally {
      setResendingOtp(false);
    }
  }, []);
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
    setLoginState(data.loginState);
    setOtpAttempts(data.otpAttempts || 0);
    setOtpMaxAttempts(data.otpMaxAttempts || 3);
    setAgentEnabled(Boolean(data.agentEnabled));
    setAgentUi(data.agentUi);
    if (!data.otpRequired) {
      setOtpCode('');
    }
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

  const startLogin = useCallback(async (visible = false) => {
    if (visible) {
      setStartingVisible(true);
    } else {
      setStarting(true);
    }
    setStatus('running');
    setQrCode(undefined);
    setExpiresAt(undefined);
    setViewUrl(undefined);
    setLoginState(undefined);
    setOtpCode('');
    setOtpAttempts(0);
    setAgentUi(undefined);
    setMessage(
      visible
        ? 'Opening a live browser you can drive by hand…'
        : 'Installing verified RedNote tools if needed…'
    );
    try {
      const response = await fetch('/integrations/rednote/login/start', {
        method: 'POST',
        body: JSON.stringify({ ...configuration, visible }),
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
      setLoginState(data.loginState);
      setOtpAttempts(data.otpAttempts || 0);
      setOtpMaxAttempts(data.otpMaxAttempts || 3);
      setAgentEnabled(Boolean(data.agentEnabled));
      setAgentUi(data.agentUi);
      setViewUrl(data.viewUrl);
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to create the RedNote login QR code.'
      );
    } finally {
      setStarting(false);
      setStartingVisible(false);
    }
  }, [configuration, fetch]);

  const submitOtp = useCallback(async () => {
    if (!/^\d{6}$/.test(otpCode)) {
      setMessage('Enter the six-digit verification code from Xiaohongshu.');
      return;
    }

    const code = otpCode;
    setOtpCode('');
    setSubmittingOtp(true);
    setMessage('Submitting the verification code securely…');
    try {
      const response = await fetch('/integrations/rednote/login/otp', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      const data = (await response.json()) as SetupResponse;
      if (!response.ok) {
        throw new Error(
          responseError(data, 'Unable to submit the verification code.')
        );
      }
      setStatus(data.status || 'running');
      setMessage(
        responseError(
          data,
          'Verification code submitted. Waiting for login confirmation…'
        )
      );
      setLoginState(data.loginState);
      setOtpAttempts(data.otpAttempts || 0);
      setOtpMaxAttempts(data.otpMaxAttempts || 3);
      setAgentEnabled(Boolean(data.agentEnabled));
      setAgentUi(data.agentUi);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to submit the verification code.'
      );
    } finally {
      setSubmittingOtp(false);
    }
  }, [fetch, otpCode]);

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
      if (!startData.code) {
        throw new Error(
          'Postiz did not return the isolated RedNote connection credential.'
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
        `/integrations/social/rednote?state=${encodeURIComponent(
          stateData.url
        )}&code=${encodeURIComponent(startData.code)}${
          onboarding ? '&onboarding=true' : ''
        }`
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
  const showOtp =
    agentUi?.view === 'otp' ||
    (!agentUi &&
      (loginState === 'otp_required' ||
        loginState === 'submitting_otp' ||
        loginState === 'otp_submitted'));
  const showQr = agentUi ? agentUi.view === 'qr' : Boolean(qrCode);
  const agentToneClass =
    agentUi?.tone === 'success'
      ? 'border-green-500/40 bg-green-500/10'
      : agentUi?.tone === 'danger'
      ? 'border-red-500/40 bg-red-500/10'
      : agentUi?.tone === 'warning'
      ? 'border-orange-500/40 bg-orange-500/10'
      : 'border-tableBorder bg-newBgColorInner';

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
        {agentUi ? (
          <div
            className={`rounded-[8px] border p-[12px] ${agentToneClass}`}
            data-testid="rednote-login-agent-view"
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
        {viewUrl && status === 'running' ? (
          <div className="flex flex-col gap-[8px] rounded-[8px] border border-tableBorder p-[8px]">
            <div className="text-[12px] text-textColor/70">
              Live browser — scan the QR shown here, and if Xiaohongshu asks for
              an SMS code, click the field and type it directly in this window.
              VNC password if prompted: ask your admin.
            </div>
            <iframe
              src={viewUrl}
              title="RedNote live login browser"
              className="h-[560px] w-full rounded-[6px] border border-newTableBorder bg-black"
              allow="clipboard-read; clipboard-write"
            />
          </div>
        ) : null}
        {showQr && qrCode ? (
          <div className="flex flex-col items-center gap-[8px] rounded-[8px] bg-white p-[14px]">
            <img
              src={qrCode}
              alt={
                loginState === 'captcha_required'
                  ? 'Xiaohongshu account-security verification QR code'
                  : 'Xiaohongshu login QR code'
              }
              width={260}
              height={260}
              className="h-[260px] w-[260px] object-contain"
            />
            <div className="text-center text-[12px] text-black/60">
              {loginState === 'captcha_required'
                ? 'Second verification step: scan this refreshed QR with the Xiaohongshu account already signed in on your phone.'
                : expiresAt
                ? `Valid until ${new Date(expiresAt).toLocaleTimeString()}`
                : 'This QR code is valid for about four minutes.'}
            </div>
          </div>
        ) : null}
        {showOtp ? (
          <form
            className="flex flex-col gap-[8px] rounded-[8px] border border-orange-500/40 bg-orange-500/10 p-[12px]"
            onSubmit={(event) => {
              event.preventDefault();
              void submitOtp();
            }}
          >
            <div>
              <div className="text-[13px] font-semibold">
                Xiaohongshu verification code
              </div>
              <div className="text-[12px] text-textColor/65">
                Enter the six-digit code sent by Xiaohongshu. It is submitted
                directly to the retained headless browser and is not saved by
                Postiz.
              </div>
            </div>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={otpCode}
              disabled={
                loginState !== 'otp_required' || submittingOtp || connecting
              }
              onChange={(event) =>
                setOtpCode(event.target.value.replace(/\D/g, '').slice(0, 6))
              }
              aria-label="Xiaohongshu six-digit verification code"
              placeholder="000000"
              className="h-[42px] rounded-[8px] border border-newTableBorder bg-newBgColorInner px-[16px] text-center text-[20px] tracking-[0.35em] text-textColor outline-none disabled:opacity-60"
            />
            <div className="flex items-center justify-between gap-[10px]">
              <div className="flex items-center gap-[10px] text-[11px] text-textColor/60">
                <span>
                  Attempts: {otpAttempts}/{otpMaxAttempts}
                </span>
                <button
                  type="button"
                  onClick={resendOtp}
                  disabled={
                    loginState !== 'otp_required' ||
                    resendingOtp ||
                    submittingOtp ||
                    resendCooldown > 0
                  }
                  className="underline disabled:no-underline disabled:opacity-60"
                >
                  {resendingOtp
                    ? 'Resending…'
                    : resendCooldown > 0
                    ? `Resend code (${resendCooldown}s)`
                    : "Didn't get the SMS? Resend code"}
                </button>
              </div>
              <Button
                type="submit"
                loading={submittingOtp}
                disabled={
                  loginState !== 'otp_required' ||
                  submittingOtp ||
                  otpCode.length !== 6
                }
              >
                Submit Code
              </Button>
            </div>
          </form>
        ) : null}
        <div className="flex flex-col gap-[8px]">
          <Button
            type="button"
            onClick={() => startLogin(false)}
            loading={starting}
            disabled={starting || startingVisible || connecting || status === 'running'}
          >
            {status === 'running'
              ? 'Login Session Active'
              : status === 'success'
              ? 'Log in with Another Account'
              : agentUi?.primaryAction === 'restart'
              ? 'Start New Login Session'
              : 'Get Xiaohongshu QR Code'}
          </Button>
          <Button
            type="button"
            secondary
            onClick={() => startLogin(true)}
            loading={startingVisible}
            disabled={starting || startingVisible || connecting || status === 'running'}
          >
            Log in with live browser (manual scan &amp; SMS)
          </Button>
        </div>
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
