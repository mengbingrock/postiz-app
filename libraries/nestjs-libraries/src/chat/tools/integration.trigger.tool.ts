import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import {
  IntegrationManager,
  socialIntegrationList,
} from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { timer } from '@gitroom/helpers/utils/timer';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import {
  chineseInLAProxyConfigured,
  EgressRelayService,
  redNoteProxyConfigured,
} from '@gitroom/nestjs-libraries/egress/egress.relay.service';
import { ChineseInLAProvider } from '@gitroom/nestjs-libraries/integrations/social/chineseinla.provider';
import { RedNoteProvider } from '@gitroom/nestjs-libraries/integrations/social/rednote.provider';

@Injectable()
export class IntegrationTriggerTool implements AgentToolInterface {
  constructor(
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _egressRelayService: EgressRelayService
  ) {}
  name = 'triggerTool';

  run() {
    return createTool({
      id: 'triggerTool',
      description: `Use this to call a provider-scoped helper function (a methodName from the integrationSchema callable tools). Helpers can fetch provider-specific data such as ids, search results, forum topics, and post details, or explicitly prepare a provider preview when the schema says so.
      Some helper functions require values provided by the user. Never guess or invent a methodName; use only one advertised by integrationSchema [input:callable-tools].
      If provider auth is expired, this tool may refresh the stored integration token; if refresh fails, it marks the channel as needing reconnect and notifies the organization.`,
      mcp: {
        annotations: {
          title: 'Trigger Integration Tool',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      inputSchema: z.object({
        integrationId: z.string().describe('The id of the integration'),
        methodName: z
          .string()
          .describe(
            'The methodName from the `integrationSchema` functions in the tools array, required'
          ),
        dataSchema: z.array(
          z.object({
            key: z.string().describe('Name of the settings key to pass'),
            value: z.string().describe('Value of the key'),
          })
        ),
      }),
      outputSchema: z.object({
        output: z.union([
          z.array(z.record(z.string(), z.any())),
          z.record(z.string(), z.any()),
          z.string(),
        ]),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organizationId = JSON.parse(
          (context?.requestContext as any)?.get('organization') as string
        ).id;

        const getIntegration =
          await this._integrationService.getIntegrationById(
            organizationId,
            inputData.integrationId
          );

        if (!getIntegration) {
          throw new Error(
            'Integration not found, use integrationList to get a valid integration id'
          );
        }

        const integrationProvider = socialIntegrationList.find(
          (p) => p.identifier === getIntegration.providerIdentifier
        )!;

        if (!integrationProvider) {
          throw new Error(
            'Integration provider not found, use integrationList to get a valid integration id'
          );
        }

        const tools = this._integrationManager.getAllTools();
        if (
          // @ts-ignore
          !tools[integrationProvider.identifier].some(
            (p) => p.methodName === inputData.methodName
          ) ||
          // @ts-ignore
          !integrationProvider[inputData.methodName]
        ) {
          throw new Error(
            `Method "${inputData.methodName}" not found for this integration, use integrationSchema to get the callable tools`
          );
        }

        let refreshed = false;
        while (true) {
          try {
            // ChineseInLA rejects cloud-provider IPs. Establish and verify the
            // organization's local route before the provider is allowed to
            // connect to (or launch) its dedicated browser.
            if (
              getIntegration.providerIdentifier === 'chineseinla' &&
              chineseInLAProxyConfigured()
            ) {
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
              await (integrationProvider as ChineseInLAProvider).configureEgress(
                getIntegration.token,
                proxyUrl
              );
            }
            if (
              getIntegration.providerIdentifier === 'rednote' &&
              redNoteProxyConfigured()
            ) {
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
              await (integrationProvider as RedNoteProvider).configureEgress(
                getIntegration.token,
                proxyUrl
              );
            }
            // @ts-ignore
            const load = await integrationProvider[inputData.methodName](
              getIntegration.token,
              inputData.dataSchema.reduce(
                (all: Record<string, string>, current: { key: string; value: string }) => ({
                  ...all,
                  [current.key]: current.value,
                }),
                {} as Record<string, string>
              ),
              getIntegration.internalId,
              getIntegration
            );

            return { output: load };
          } catch (err) {
            if (err instanceof RefreshToken && !refreshed) {
              refreshed = true;
              const data = await this._refreshIntegrationService.refresh(
                getIntegration
              );

              if (!data) {
                await this._integrationService.disconnectChannel(
                  organizationId,
                  getIntegration
                );
                throw new Error(
                  'The channel was disconnected because its token expired, the user needs to reconnect it in Postiz'
                );
              }

              const { accessToken } = data;

              if (accessToken) {
                getIntegration.token = accessToken;

                if (integrationProvider.refreshWait) {
                  await timer(10000);
                }

                continue;
              }
            }

            if (err instanceof RefreshToken) {
              throw new Error(
                'The provider rejected the credentials even after refreshing the token, the user needs to reconnect the channel in Postiz'
              );
            }

            throw new Error(
              `Provider call failed: ${
                err instanceof Error && err.message
                  ? err.message
                  : 'unexpected error'
              }`
            );
          }
        }
      },
    });
  }
}
