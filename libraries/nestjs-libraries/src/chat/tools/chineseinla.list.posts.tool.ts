import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { ChineseInLAProvider } from '@gitroom/nestjs-libraries/integrations/social/chineseinla.provider';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

@Injectable()
export class ChineseInLAListPostsTool implements AgentToolInterface {
  constructor(
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService
  ) {}

  name = 'chineseInLAListPostsTool';

  run() {
    return createTool({
      id: 'chineseInLAListPostsTool',
      description: `
List topic IDs from one ChineseInLA forum. Call chineseInLAListForumsTool first and pass the matching categoryId and forumId pair; do not guess either ID. The returned topicId can be passed to chineseInLAReadPostTool. This tool is read-only and never prepares or publishes content.
`,
      mcp: {
        annotations: {
          title: 'List ChineseInLA Posts',
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
        categoryId: z
          .number()
          .int()
          .positive()
          .describe('Category/group ID from chineseInLAListForumsTool'),
        forumId: z
          .number()
          .int()
          .positive()
          .describe('Forum ID from chineseInLAListForumsTool'),
        page: z.number().int().min(1).max(100).default(1),
        limit: z.number().int().min(1).max(15).default(15),
      }),
      outputSchema: z.object({
        output: z.object({
          integrationId: z.string(),
          integrationName: z.string(),
          categoryId: z.number(),
          forum: z.object({
            id: z.number(),
            name: z.string(),
            groupId: z.number().optional(),
            group: z.string().optional(),
            description: z.string().optional(),
            restricted: z.boolean(),
          }),
          page: z.number(),
          pageSize: z.number(),
          hasNext: z.boolean(),
          posts: z.array(
            z.object({
              topicId: z.number(),
              url: z.string(),
              title: z.string(),
              author: z.string().optional(),
              authorId: z.number().optional(),
              updatedAt: z.string().optional(),
              replyCount: z.number(),
              viewCount: z.number(),
              hasImages: z.boolean(),
              highlighted: z.boolean(),
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
            'Reconnect the ChineseInLA integration before listing its posts.'
          );
        }
        const provider = this._integrationManager.getSocialIntegration(
          'chineseinla'
        ) as ChineseInLAProvider;
        const result = await provider.listPosts(
          integration.token,
          inputData.categoryId,
          inputData.forumId,
          inputData.page,
          inputData.limit
        );
        return {
          output: {
            integrationId: integration.id,
            integrationName: integration.name,
            ...result,
          },
        };
      },
    });
  }
}
