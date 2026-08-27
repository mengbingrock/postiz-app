import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { ChineseInLAProvider } from '@gitroom/nestjs-libraries/integrations/social/chineseinla.provider';
import { ChineseInLADto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/chineseinla.dto';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import {
  ValidUrlExtension,
  ValidUrlPath,
} from '@gitroom/helpers/utils/valid.url.path';

const validUrlExtension = new ValidUrlExtension();
const validUrlPath = new ValidUrlPath();

const attachmentUrl = z
  .string()
  .refine((url) => validUrlPath.validate(url, {} as any), {
    message: validUrlPath.defaultMessage({} as any),
  })
  .refine((url) => validUrlExtension.validate(url, {} as any), {
    message: validUrlExtension.defaultMessage({} as any),
  });

@Injectable()
export class ChineseInLAPreparePostTool implements AgentToolInterface {
  constructor(
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService
  ) {}

  name = 'chineseInLAPreparePostTool';

  run() {
    return createTool({
      id: 'chineseInLAPreparePostTool',
      description: `
Prepare a ChineseInLA post for terminal review without publishing it.
Use chineseInLAListForumsTool first when the numeric forum ID is unknown.
Call this only after the user explicitly approves filling the exact forum, post type, title, content, tags, source URL, and attachments. Preparation may upload attachments but never clicks Publish.
The result includes a draftId and a PNG data URL. Show or decode the preview and obtain a separate explicit confirmation. Only then call integrationSchedulePostTool exactly once with type "now", the same payload, and a settings entry whose key is "preparedDraftId" and value is this exact draftId.
Calling this tool again replaces the previous prepared ChineseInLA draft.
`,
      mcp: {
        annotations: {
          title: 'Prepare ChineseInLA Post for Review',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe('Connected ChineseInLA integration ID'),
        forumId: z.number().int().positive(),
        postType: z.enum(['question', 'classified', 'other']),
        title: z.string().trim().min(1).max(120),
        content: z
          .string()
          .min(1)
          .max(10_000)
          .describe(
            'Post body. Postiz HTML paragraphs are accepted and converted to plain text before the ChineseInLA form is filled.'
          ),
        tags: z.string().max(240).optional(),
        sourceUrl: z.string().url().optional(),
        attachments: z.array(attachmentUrl).default([]),
        confirmPreparation: z
          .literal(true)
          .describe(
            'Must be true only after the user approves filling this exact payload for preview; this does not authorize publication.'
          ),
      }),
      outputSchema: z.object({
        output: z.object({
          draftId: z.string(),
          preview: z.string(),
          forum: z.object({
            id: z.number(),
            name: z.string(),
            groupId: z.number().optional(),
            group: z.string().optional(),
            description: z.string().optional(),
            restricted: z.boolean(),
          }),
          postType: z.string(),
          postTypeName: z.string(),
          title: z.string(),
          body: z.string(),
          imageCount: z.number(),
          warnings: z.array(z.string()),
          message: z.string(),
          nextStep: z.string(),
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
            'Reconnect the ChineseInLA integration before preparing a post.'
          );
        }

        const provider = this._integrationManager.getSocialIntegration(
          'chineseinla'
        ) as ChineseInLAProvider;
        const prepared = await provider.preparePost(
          integration.token,
          {
            forumId: inputData.forumId,
            postType: inputData.postType,
            title: inputData.title,
            tags: inputData.tags,
            sourceUrl: inputData.sourceUrl,
          } as ChineseInLADto,
          [
            {
              content: inputData.content,
              media: inputData.attachments.map((path) => ({
                path,
                type: /\.mp4(?:$|\?)/i.test(path) ? 'video' : 'image',
              })),
            },
          ]
        );

        return {
          output: {
            ...prepared,
            nextStep:
              'Review the PNG preview and normalized body. After a separate explicit user confirmation, call integrationSchedulePostTool once with type "now", the identical payload, and preparedDraftId set to this draftId.',
          },
        };
      },
    });
  }
}
