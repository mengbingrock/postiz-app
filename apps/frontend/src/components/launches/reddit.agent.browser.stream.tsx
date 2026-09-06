'use client';

import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import React, {
  FC,
  KeyboardEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  WheelEvent,
} from 'react';

type BrowserFrame = {
  frame?: string;
  width?: number;
  height?: number;
  version?: number;
  message?: string | string[];
};

type BrowserInput =
  | {
      kind: 'mouse';
      type: 'move' | 'down' | 'up';
      x: number;
      y: number;
      button: 'left' | 'middle' | 'right';
    }
  | {
      kind: 'wheel';
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
    }
  | {
      kind: 'key';
      type: 'down' | 'up';
      key: string;
      code: string;
      text?: string;
      modifiers: number;
    }
  | { kind: 'text'; text: string };

const responseMessage = (data: BrowserFrame, fallback: string) =>
  Array.isArray(data.message)
    ? data.message.join(', ')
    : data.message || fallback;

const mouseButton = (button: number): 'left' | 'middle' | 'right' =>
  button === 1 ? 'middle' : button === 2 ? 'right' : 'left';

const keyModifiers = (event: KeyboardEvent) =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

export const RedditAgentBrowserStream: FC<{
  viewerPath: string;
  className?: string;
}> = ({ viewerPath, className = 'h-[620px]' }) => {
  const fetch = useFetch();
  const viewerId = useMemo(
    () =>
      decodeURIComponent(viewerPath.split('/').filter(Boolean).at(-1) || ''),
    [viewerPath]
  );
  const [frame, setFrame] = useState<BrowserFrame>();
  const [error, setError] = useState('');
  const [externalViewerUrl, setExternalViewerUrl] = useState('');
  const pointerDown = useRef(false);

  const frameEndpoint = `/integrations/reddit-agent/login/viewer/${encodeURIComponent(
    viewerId
  )}/frame`;
  const inputEndpoint = `/integrations/reddit-agent/login/viewer/${encodeURIComponent(
    viewerId
  )}/input`;

  useEffect(() => {
    let active = true;
    let timer: number;
    const poll = async () => {
      let delay = 300;
      try {
        const response = await fetch(frameEndpoint);
        const data = (await response.json()) as BrowserFrame;
        if (!response.ok) {
          throw new Error(
            responseMessage(data, 'The interactive browser is unavailable.')
          );
        }
        if (active) {
          if (data.frame) setFrame(data);
          setError('');
          delay = data.frame ? 120 : 250;
        }
      } catch (cause) {
        if (active) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'The interactive browser is unavailable.'
          );
          delay = 1_000;
        }
      } finally {
        if (active) timer = window.setTimeout(poll, delay);
      }
    };
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [fetch, frameEndpoint]);

  useEffect(() => {
    let active = true;
    void fetch(
      `/integrations/reddit-agent/login/viewer/${encodeURIComponent(viewerId)}`
    )
      .then(async (response) => {
        const data = (await response.json()) as {
          externalViewerUrl?: string;
        };
        if (active && response.ok && data.externalViewerUrl) {
          setExternalViewerUrl(data.externalViewerUrl);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [fetch, viewerId]);

  const sendInput = useCallback(
    (input: BrowserInput) => {
      void fetch(inputEndpoint, {
        method: 'POST',
        body: JSON.stringify(input),
      })
        .then(async (response) => {
          if (response.ok) return;
          const data = (await response.json()) as BrowserFrame;
          throw new Error(
            responseMessage(data, 'The browser rejected the input.')
          );
        })
        .catch((cause) => {
          setError(
            cause instanceof Error
              ? cause.message
              : 'The browser rejected the input.'
          );
        });
    },
    [fetch, inputEndpoint]
  );

  const point = useCallback(
    (event: PointerEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      return {
        x:
          ((event.clientX - bounds.left) / Math.max(1, bounds.width)) *
          (frame?.width || 1280),
        y:
          ((event.clientY - bounds.top) / Math.max(1, bounds.height)) *
          (frame?.height || 900),
      };
    },
    [frame?.height, frame?.width]
  );

  const onKey = useCallback(
    (type: 'down' | 'up', event: KeyboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const printable =
        type === 'down' &&
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey;
      sendInput({
        kind: 'key',
        type,
        key: event.key,
        code: event.code,
        text: printable ? event.key : undefined,
        modifiers: keyModifiers(event),
      });
    },
    [sendInput]
  );

  return (
    <div
      tabIndex={0}
      className={`relative overflow-hidden bg-black outline-none focus:ring-2 focus:ring-primary ${className}`}
      onKeyDown={(event) => onKey('down', event)}
      onKeyUp={(event) => onKey('up', event)}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData('text').slice(0, 2_000);
        if (text) sendInput({ kind: 'text', text });
      }}
    >
      {frame?.frame ? (
        <img
          src={frame.frame}
          alt="Interactive Reddit login browser"
          draggable={false}
          className="h-full w-full select-none object-contain"
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            event.preventDefault();
            pointerDown.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.parentElement?.focus();
            sendInput({
              kind: 'mouse',
              type: 'down',
              ...point(event),
              button: mouseButton(event.button),
            });
          }}
          onPointerMove={(event) => {
            if (!pointerDown.current) return;
            sendInput({
              kind: 'mouse',
              type: 'move',
              ...point(event),
              button: mouseButton(event.button),
            });
          }}
          onPointerUp={(event) => {
            event.preventDefault();
            pointerDown.current = false;
            sendInput({
              kind: 'mouse',
              type: 'up',
              ...point(event),
              button: mouseButton(event.button),
            });
          }}
          onWheel={(event) => {
            event.preventDefault();
            sendInput({
              kind: 'wheel',
              ...point(event),
              deltaX: event.deltaX,
              deltaY: event.deltaY,
            });
          }}
        />
      ) : (
        <div className="flex h-full items-center justify-center p-[24px] text-center text-[12px] text-white/70">
          {error || 'Waiting for the first browser frame…'}
        </div>
      )}
      {error && frame?.frame ? (
        <div className="absolute inset-x-0 bottom-0 bg-red-950/90 px-[10px] py-[6px] text-[11px] text-white">
          {error}
        </div>
      ) : null}
      {externalViewerUrl ? (
        <button
          type="button"
          className="absolute right-[10px] top-[10px] rounded-[6px] bg-black/75 px-[9px] py-[5px] text-[10px] text-white hover:bg-black"
          onClick={() =>
            window.open(externalViewerUrl, '_blank', 'noopener,noreferrer')
          }
        >
          Browserless fallback
        </button>
      ) : null}
    </div>
  );
};
