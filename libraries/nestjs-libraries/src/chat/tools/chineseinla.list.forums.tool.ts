import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { ChineseInLAProvider } from '@gitroom/nestjs-libraries/integrations/social/chineseinla.provider';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

@Injectable()
export class ChineseInLAListForumsTool implements AgentToolInterface {
  constructor(
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService
  ) {}

  name = 'chineseInLAListForumsTool';

  run() {
    return createTool({
      id: 'chineseInLAListForumsTool',
      description: `
List the live ChineseInLA forum catalog, including the numeric forum and category IDs required to prepare a post.
Call integrationList first to get the connected ChineseInLA integration ID, then pass it here. Use the returned forum id whose name and group match the user's requested destination. This tool is read-only and does not prepare or publish a post.
`,
      mcp: {
        annotations: {
          title: 'List ChineseInLA Forums',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe(
            'Connected ChineseInLA integration ID from integrationList'
          ),
      }),
      outputSchema: z.object({
        output: z.object({
          integrationId: z.string(),
          integrationName: z.string(),
          count: z.number(),
          forums: z.array(
            z.object({
              id: z.number(),
              name: z.string(),
              groupId: z.number().optional(),
              group: z.string().optional(),
              description: z.string().optional(),
              restricted: z.boolean(),
            })
          ),
        }),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organizationId = JSON.parse(
          (context?.requestContext as any)?.get('organization') as string
        ).id;
        const integration = await this._integrationService.getIntegrationById(
          organizationId,
          inputData.integrationId
        );
        if (!integration || integration.providerIdentifier !== 'chineseinla') {
          throw new Error(
            'ChineseInLA integration not found; use integrationList to get a valid integration ID.'
          );
        }
        if (integration.disabled || integration.refreshNeeded) {
          throw new Error(
            'Reconnect the ChineseInLA integration before listing its forums.'
          );
        }

        const provider = this._integrationManager.getSocialIntegration(
          'chineseinla'
        ) as ChineseInLAProvider;
        const forums = await provider.listForums(integration.token);

        return {
          output: {
            integrationId: integration.id,
            integrationName: integration.name,
            count: forums.length,
            forums,
          },
        };
      },
    });
  }
}
