import { Injectable } from '@nestjs/common';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { AgentToolInterface } from '../agent.tool.interface';
import { checkAuth } from '../auth.context';
import { EgressRelayService } from '../../egress/egress.relay.service';

const organizationId = (inputData: unknown, context: any) => {
  checkAuth(inputData, context);
  return JSON.parse(context?.requestContext?.get('organization') as string)
    .id as string;
};

@Injectable()
export class EgressProxyStatusTool implements AgentToolInterface {
  name = 'egressProxyStatusTool';
  constructor(private readonly relay: EgressRelayService) {}
  run() {
    return createTool({
      id: this.name,
      description:
        'Report local Postiz MCP connector devices and the current on-demand egress lease. Read-only.',
      mcp: {
        annotations: {
          title: 'Egress Proxy Status',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      inputSchema: z.object({}),
      outputSchema: z.object({ output: z.any() }),
      execute: async (inputData, context) => ({
        output: this.relay.status(organizationId(inputData, context)),
      }),
    });
  }
}

@Injectable()
export class EgressProxyStartTool implements AgentToolInterface {
  name = 'egressProxyStartTool';
  constructor(private readonly relay: EgressRelayService) {}
  run() {
    return createTool({
      id: this.name,
      description:
        'Start or renew a time-limited local egress lease after the user explicitly asks to use their connected machine as the network route.',
      mcp: {
        annotations: {
          title: 'Start Egress Proxy',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      inputSchema: z.object({
        deviceId: z
          .string()
          .optional()
          .describe(
            'Connected local device ID; omit when only one device is online'
          ),
        ttlMinutes: z.number().int().min(5).max(60).default(30),
      }),
      outputSchema: z.object({ output: z.any() }),
      execute: async (inputData, context) => ({
        output: await this.relay.startLease(
          organizationId(inputData, context),
          inputData.deviceId,
          inputData.ttlMinutes
        ),
      }),
    });
  }
}

@Injectable()
export class EgressProxyStopTool implements AgentToolInterface {
  name = 'egressProxyStopTool';
  constructor(private readonly relay: EgressRelayService) {}
  run() {
    return createTool({
      id: this.name,
      description:
        "Stop the organization's active local egress lease and close its forwarded streams.",
      mcp: {
        annotations: {
          title: 'Stop Egress Proxy',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      inputSchema: z.object({}),
      outputSchema: z.object({ output: z.any() }),
      execute: async (inputData, context) => ({
        output: this.relay.stopLease(organizationId(inputData, context)),
      }),
    });
  }
}

@Injectable()
export class EgressProxyTestTool implements AgentToolInterface {
  name = 'egressProxyTestTool';
  constructor(private readonly relay: EgressRelayService) {}
  run() {
    return createTool({
      id: this.name,
      description:
        'Verify the active local egress lease and return its observed public IP. Read-only.',
      mcp: {
        annotations: {
          title: 'Test Egress Proxy',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      inputSchema: z.object({}),
      outputSchema: z.object({ output: z.any() }),
      execute: async (inputData, context) => ({
        output: await this.relay.testLease(organizationId(inputData, context)),
      }),
    });
  }
}
