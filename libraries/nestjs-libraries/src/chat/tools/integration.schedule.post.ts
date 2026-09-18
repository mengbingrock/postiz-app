import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { AllProvidersSettings } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/all.providers.settings';
import { Integration } from '@prisma/client';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import {
  ValidUrlExtension,
  ValidUrlPath,
} from '@gitroom/helpers/utils/valid.url.path';
import {
  chineseInLAProxyConfigured,
  EgressRelayService,
  redNoteProxyConfigured,
} from '@gitroom/nestjs-libraries/egress/egress.relay.service';
import { ChineseInLAProvider } from '@gitroom/nestjs-libraries/integrations/social/chineseinla.provider';
import { RedNoteProvider } from '@gitroom/nestjs-libraries/integrations/social/rednote.provider';
import { socialIntegrationList } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { prepareVideoCovers } from './video.cover';

const validUrlExtension = new ValidUrlExtension();
const validUrlPath = new ValidUrlPath();

// Same URL validation as MediaDto (valid.url.path) - each attachment must
// point to an allowed upload domain and a supported file extension.
const attachmentUrl = z
  .string()
  .refine((url) => validUrlPath.validate(url, {} as any), {
    message: validUrlPath.defaultMessage({} as any),
  })
  .refine((url) => validUrlExtension.validate(url, {} as any), {
    message: validUrlExtension.defaultMessage({} as any),
  });

const coverAttachment = z
  .object({
    path: attachmentUrl,
    thumbnail: attachmentUrl
      .refine(
        (url) =>
          /^https:\/\//i.test(url) &&
          /\.(png|jpe?g)$/i.test(url.split(/[?#]/)[0]),
        'Upload a JPEG/PNG cover to Postiz and use its HTTPS URL.'
      )
      .optional(),
    thumbnailTimestamp: z
      .number()
      .int()
      .min(0)
      .max(2147483647)
      .optional()
      .describe(
        'Video frame offset in milliseconds; do not combine with thumbnail.'
      ),
  })
  .strict();

@Injectable()
export class IntegrationSchedulePostTool implements AgentToolInterface {
  constructor(
    private _postsService: PostsService,
    private _integrationService: IntegrationService,
    private _egressRelayService: EgressRelayService
  ) {}
  name = 'integrationSchedulePostTool';

  run() {
    return createTool({
      id: 'schedulePostTool',
      mcp: {
        annotations: {
          title: 'Schedule Social Media Post',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      description: `
Use this when the user wants to create a draft, scheduled, or immediate social media post on their connected channels, based on the integrationSchema tool.
Examples of the input shape:

A single LinkedIn post with one comment
- socialPost array length will be one
- postsAndComments array length will be two (one for the post, one for the comment)

20 Facebook posts each on individual days without comments
- socialPost array length will be 20
- postsAndComments array length will be one

Do not use this to update or delete existing posts.
For a custom video cover, upload the video and JPEG/PNG separately, then use ONE attachment object {path: videoUrl, thumbnail: coverUrl}, not two attachments. Legacy string URLs still work. For supported frame selection use {path: videoUrl, thumbnailTimestamp: milliseconds}. Unsupported platform/post combinations return errors before creation; never silently omit a requested cover. YouTube also accepts settings.thumbnail. A successful publish is not proof the platform displays the cover: verify the published result separately.
If validation fails, the result contains output.errors describing what to fix; the call can be retried with corrected parameters.
For an immediate ChineseInLA post, call integrationSchema for platform "chineseinla", then call the advertised preparePostForReview provider helper through triggerTool. Review its PNG preview and obtain a separate explicit user confirmation. Then call this tool once with the identical payload and include preparedDraftId in settings. Never create a ChineseInLA "now" post without that preparation step.
`,
      inputSchema: z.object({
        socialPost: z
          .array(
            z.object({
              integrationId: z
                .string()
                .describe('The id of the integration (not internal id)'),
              isPremium: z
                .boolean()
                .describe(
                  "If the integration is X, return if it's premium or not"
                ),
              date: z.string().describe('The date of the post in UTC time'),
              shortLink: z
                .boolean()
                .describe(
                  'If the post has a link inside, we can ask the user if they want to add a short link'
                ),
              type: z
                .enum(['draft', 'schedule', 'now'])
                .describe(
                  'The type of the post, if we pass now, we should pass the current date also'
                ),
              postsAndComments: z
                .array(
                  z.object({
                    content: z
                      .string()
                      .describe(
                        "The content of the post, HTML, Each line must be wrapped in <p> here is the possible tags: h1, h2, h3, u, strong, li, ul, p (you can't have u and strong together)"
                      ),
                    attachments: z
                      .array(z.union([attachmentUrl, coverAttachment]))
                      .describe(
                        'Uploaded media URLs or video objects with an explicit cover image or frame timestamp'
                      ),
                  })
                )
                .describe(
                  'first item is the post, every other item is the comments'
                ),
              settings: z
                .array(
                  z.object({
                    key: z
                      .string()
                      .describe('Name of the settings key to pass'),
                    value: z
                      .any()
                      .describe(
                        'Value of the key, always prefer the id then label if possible'
                      ),
                  })
                )
                .describe(
                  'This relies on the integrationSchema tool to get the settings [input:settings]'
                ),
            })
          )
          .describe('Individual post'),
      }),
      outputSchema: z.object({
        output: z
          .array(
            z.object({
              postId: z.string(),
              integration: z.string(),
            })
          )
          .or(z.object({ errors: z.string() })),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organizationId = JSON.parse(
          (context?.requestContext as any)?.get('organization') as string
        ).id;
        const finalOutput = [];

        const integrations = {} as Record<string, Integration>;
        const prepared = new Map<any, ReturnType<typeof prepareVideoCovers>>();
        for (const platform of inputData.socialPost) {
          integrations[platform.integrationId] =
            await this._integrationService.getIntegrationById(
              organizationId,
              platform.integrationId
            );

          // Same server-side validation as the dashboard / public API
          // (settings DTO + media checkValidity + empty / too-long content).
          const settings = platform.settings.reduce(
            (acc: AllProvidersSettings, s: { key: string; value: any }) => ({
              ...acc,
              [s.key]: s.value,
            }),
            {} as AllProvidersSettings
          );

          try {
            prepared.set(
              platform,
              prepareVideoCovers(
                integrations[platform.integrationId]?.providerIdentifier,
                platform.postsAndComments,
                settings
              )
            );
          } catch (error) {
            return { output: { errors: (error as Error).message } };
          }

          if (
            integrations[platform.integrationId]?.providerIdentifier ===
            'chineseinla'
          ) {
            if (platform.type === 'schedule') {
              return {
                output: {
                  errors:
                    'ChineseInLA supports only draft or immediate publishing. Use type "now" after terminal preview confirmation.',
                },
              };
            }
            if (
              platform.type === 'now' &&
              !String((settings as any).preparedDraftId || '').trim()
            ) {
              return {
                output: {
                  errors:
                    'ChineseInLA requires a preparedDraftId. Call integrationSchema for platform "chineseinla", invoke its preparePostForReview helper through triggerTool, review the PNG preview, obtain a separate explicit confirmation, then retry integrationSchedulePostTool with the same payload and returned draftId.',
                },
              };
            }
          }

          const [validation] = await this._postsService.validatePosts(
            organizationId,
            [
              {
                integration: { id: platform.integrationId },
                settings: prepared.get(platform)!.settings,
                value: prepared.get(platform)!.value,
              },
            ]
          );

          if (validation.emptyContent) {
            return {
              output: {
                errors: `${validation.name}: Your post should have at least one character or one image.`,
              },
            };
          }

          if (platform.type !== 'draft') {
            if (!validation.valid) {
              return {
                output: {
                  errors: `${validation.name}: ${
                    validation.settingsError || 'Please fix your settings'
                  }, please fix it, and try integrationSchedulePostTool again.`,
                },
              };
            }

            if (validation.errors !== true) {
              return {
                output: {
                  errors: `${validation.name}: ${validation.errors}, please fix it, and try integrationSchedulePostTool again.`,
                },
              };
            }

            if (validation.tooLong) {
              return {
                output: {
                  errors: `${validation.name}: The maximum characters is ${validation.maximumCharacters}, please fix it, and try integrationSchedulePostTool again.`,
                },
              };
            }
          }
        }

        const immediateChineseInLAPosts = inputData.socialPost.filter(
          (post) =>
            post.type === 'now' &&
            integrations[post.integrationId]?.providerIdentifier ===
              'chineseinla'
        );
        if (immediateChineseInLAPosts.length > 1) {
          return {
            output: {
              errors:
                'Publish only one prepared ChineseInLA post per terminal call. Each preparation owns one browser form and draftId.',
            },
          };
        }

        for (const post of inputData.socialPost) {
          const integration = integrations[post.integrationId];

          if (!integration) {
            throw new Error('Integration not found');
          }

          if (
            post.type === 'now' &&
            integration.providerIdentifier === 'chineseinla' &&
            chineseInLAProxyConfigured()
          ) {
            // Renew the lease immediately before Temporal is asked to publish.
            // Preparation may have happened several minutes earlier while the
            // user reviewed the screenshot.
            const egress =
              await this._egressRelayService.ensureChineseInLALease(
                organizationId,
                undefined,
                10
              );
            const proxyUrl = egress.lease?.proxyUrl;
            if (!proxyUrl) {
              throw new Error(
                'Postiz did not allocate a tenant-specific ChineseInLA proxy.'
              );
            }
            const chineseInLAProvider = socialIntegrationList.find(
              (provider) => provider.identifier === 'chineseinla'
            ) as ChineseInLAProvider | undefined;
            if (!chineseInLAProvider) {
              throw new Error('ChineseInLA provider is unavailable.');
            }
            await chineseInLAProvider.configureEgress(
              integration.token,
              proxyUrl
            );
          }

          if (
            post.type === 'now' &&
            integration.providerIdentifier === 'rednote' &&
            redNoteProxyConfigured()
          ) {
            // Same as ChineseInLA: the lease must outlive the Temporal
            // publish that follows, so start/renew it right before createPost.
            const egress = await this._egressRelayService.ensureRedNoteLease(
              organizationId,
              undefined,
              10
            );
            const proxyUrl = egress.lease?.proxyUrl;
            if (!proxyUrl) {
              throw new Error(
                'Postiz did not allocate a tenant-specific RedNote proxy.'
              );
            }
            const redNoteProvider = socialIntegrationList.find(
              (provider) => provider.identifier === 'rednote'
            ) as RedNoteProvider | undefined;
            if (!redNoteProvider) {
              throw new Error('RedNote provider is unavailable.');
            }
            await redNoteProvider.configureEgress(integration.token, proxyUrl);
          }

          const output = await this._postsService.createPost(
            organizationId,
            {
              date: post.date,
              type: post.type as 'draft' | 'schedule' | 'now',
              shortLink: post.shortLink,
              tags: [],
              posts: [
                {
                  integration,
                  group: makeId(10),
                  settings: {
                    ...prepared.get(post)!.settings,
                    __type: integration.providerIdentifier,
                  } as AllProvidersSettings,
                  value: prepared.get(post)!.value.map((p) => ({
                    content: p.content,
                    id: makeId(10),
                    delay: 0,
                    image: p.image.map((media) => ({
                      id: makeId(10),
                      ...media,
                    })),
                  })),
                },
              ],
            },
            'MCP'
          );
          finalOutput.push(...output);
        }

        return {
          output: finalOutput,
        };
      },
    });
  }
}
