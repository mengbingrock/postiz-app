import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { ChineseInLAProvider } from '@gitroom/nestjs-libraries/integrations/social/chineseinla.provider';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

@Injectable()
export class ChineseInLAReadPostTool implements AgentToolInterface {
  constructor(
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService
  ) {}

  name = 'chineseInLAReadPostTool';

  run() {
    return createTool({
      id: 'chineseInLAReadPostTool',
      description: `
Read one ChineseInLA topic by topicId. Use the exact categoryId, forumId, and topicId returned by chineseInLAListForumsTool and chineseInLAListPostsTool. Returns the topic title and clean message bodies without ads or navigation text. This tool is read-only and never likes, replies to, edits, or publishes a post.
`,
      mcp: {
        annotations: {
          title: 'Read ChineseInLA Post',
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
        topicId: z
          .number()
          .int()
          .positive()
          .describe('Topic ID from chineseInLAListPostsTool'),
        page: z.number().int().min(1).max(100).default(1),
        limit: z.number().int().min(1).max(10).default(10),
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
          topicId: z.number(),
          url: z.string(),
          title: z.string(),
          page: z.number(),
          pageSize: z.number(),
          hasNext: z.boolean(),
          messages: z.array(
            z.object({
              postId: z.number().optional(),
              floor: z.number(),
              author: z.string().optional(),
              authorId: z.number().optional(),
              publishedAt: z.string().optional(),
              updatedAt: z.string().optional(),
              body: z.string(),
              imageUrls: z.array(z.string()).optional(),
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
            'Reconnect the ChineseInLA integration before reading its posts.'
          );
        }
        const provider = this._integrationManager.getSocialIntegration(
          'chineseinla'
        ) as ChineseInLAProvider;
        const result = await provider.readPost(
          integration.token,
          inputData.categoryId,
          inputData.forumId,
          inputData.topicId,
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
