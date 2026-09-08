import { McpConnectComponent } from '@gitroom/frontend/components/mcp/connect.component';

export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: 'Connect device to Postiz MCP',
  description: '',
};
export default async function Index() {
  return <McpConnectComponent />;
}
