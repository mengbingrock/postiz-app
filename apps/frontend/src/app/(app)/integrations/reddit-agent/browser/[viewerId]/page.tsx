'use client';

import { RedditAgentBrowserStream } from '@gitroom/frontend/components/launches/reddit.agent.browser.stream';
import { useParams } from 'next/navigation';

export default function RedditAgentBrowserPage() {
  const { viewerId } = useParams<{ viewerId: string }>();

  return (
    <main className="flex min-h-screen flex-col bg-[#0B0A0A] p-[20px] text-white">
      <div className="mb-[12px]">
        <h1 className="text-[18px] font-semibold">Secure Reddit login</h1>
        <p className="text-[12px] text-white/60">
          Click the browser, then type normally. This session closes after
          authentication.
        </p>
      </div>
      <RedditAgentBrowserStream
        viewerPath={`/integrations/reddit-agent/browser/${encodeURIComponent(
          viewerId
        )}`}
        className="min-h-[600px] flex-1 rounded-[10px] border border-white/15"
      />
    </main>
  );
}
