'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@gitroom/react/form/button';
import { useUser } from '@gitroom/frontend/components/layout/user.context';

// Browser-based device linking for `postiz-mcp login`. The CLI opens this page
// with a one-shot state nonce and the port of a listener it runs on the user's
// own machine. After the signed-in user confirms, we hand the org API key to
// http://127.0.0.1:<port>/callback. The host is hard-coded to loopback so the
// key can never be sent anywhere but the machine that started the login.
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export const McpConnectComponent = () => {
  const params = useSearchParams();
  const user = useUser();
  const [done, setDone] = useState(false);

  const state = params?.get('state') || '';
  const device = params?.get('device') || 'this device';
  const port = useMemo(() => {
    const n = Number(params?.get('port') || '');
    return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT ? n : 0;
  }, [params]);

  const publicApi = (user as { publicApi?: string } | undefined)?.publicApi || '';
  const invalid = !STATE_RE.test(state) || !port;

  const connect = useCallback(() => {
    if (invalid || !publicApi) return;
    const q = new URLSearchParams({ state, key: publicApi }).toString();
    setDone(true);
    window.location.href = `http://127.0.0.1:${port}/callback?${q}`;
  }, [invalid, publicApi, port, state]);

  return (
    <div className="flex flex-col gap-[16px] max-w-[560px] rounded-[8px] border border-tableBorder p-[24px]">
      <div className="text-[20px] font-semibold">Connect a device to Postiz MCP</div>
      {invalid ? (
        <div className="text-[13px] text-red-500">
          This link is incomplete or invalid. Run <code>postiz-mcp login</code> again on
          your device and open the URL it prints.
        </div>
      ) : !publicApi ? (
        <div className="text-[13px] text-textColor/70">
          Your account can&apos;t access this organization&apos;s API key (an ADMIN
          role is required). Ask an admin to link the device, or copy the key from
          Settings → Public API.
        </div>
      ) : done ? (
        <div className="text-[13px] text-textColor/70">
          Sent to your device. You can close this tab.
        </div>
      ) : (
        <>
          <div className="text-[13px] text-textColor/70">
            <b>{device}</b> is asking to use this organization&apos;s Postiz API key
            through the local <code>postiz-mcp</code> bridge. The key is delivered only
            to <code>127.0.0.1:{port}</code> on that device.
          </div>
          <div className="text-[12px] text-textColor/50">
            Only continue if you just ran <code>postiz-mcp login</code> yourself.
          </div>
          <div>
            <Button type="button" onClick={connect}>
              Connect {device}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};
