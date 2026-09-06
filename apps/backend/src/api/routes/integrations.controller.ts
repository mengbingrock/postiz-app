import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Integration, Organization, User } from '@prisma/client';
import { IntegrationFunctionDto } from '@gitroom/nestjs-libraries/dtos/integrations/integration.function.dto';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import { pricing } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/pricing';
import { ApiTags } from '@nestjs/swagger';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationTimeDto } from '@gitroom/nestjs-libraries/dtos/integrations/integration.time.dto';
import { PlugDto } from '@gitroom/nestjs-libraries/dtos/plugs/plug.dto';
import {
  Disconnect,
  RefreshToken,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';

import { timer } from '@gitroom/helpers/utils/timer';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { TelegramProvider } from '@gitroom/nestjs-libraries/integrations/social/telegram.provider';
import { MoltbookProvider } from '@gitroom/nestjs-libraries/integrations/social/moltbook.provider';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';
import { uniqBy } from 'lodash';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { RedNoteProvider } from '@gitroom/nestjs-libraries/integrations/social/rednote.provider';
import { ChineseInLAProvider } from '@gitroom/nestjs-libraries/integrations/social/chineseinla.provider';
import {
  RedditAgentBrowserInput,
  RedditAgentProvider,
} from '@gitroom/nestjs-libraries/integrations/social/reddit.agent.provider';
import {
  hasServerOAuthCredentials,
  missingOAuthCredentialNames,
} from '@gitroom/nestjs-libraries/integrations/social/oauth.credential.setup';
import {
  existingTokenProbeProviders,
  hasLiveChannelProbe,
  metaChannelAccessToken,
  metaProbeProviders,
  refreshProbeProviders,
} from '@gitroom/backend/api/routes/channel.check.helpers';
import { EgressRelayService } from '@gitroom/nestjs-libraries/egress/egress.relay.service';

type ChannelCheckStatus =
  | 'working'
  | 'reconnect_required'
  | 'failed'
  | 'unverified'
  | 'disabled';

type ChannelCheckResult = {
  id: string;
  name: string;
  identifier: string;
  status: ChannelCheckStatus;
  message: string;
  verified: boolean;
};

const reconnectMessage =
  /expired|invalid|not (?:logged|authenticated)|reconnect|revoked|unauthori[sz]ed|forbidden|access denied/i;

@ApiTags('Integrations')
@Controller('/integrations')
export class IntegrationsController {
  constructor(
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService,
    private _postService: PostsService,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _egressRelayService: EgressRelayService
  ) {}

  private redNoteProvider() {
    return this._integrationManager.getSocialIntegration(
      'rednote'
    ) as RedNoteProvider;
  }

  private chineseInLAProvider() {
    return this._integrationManager.getSocialIntegration(
      'chineseinla'
    ) as ChineseInLAProvider;
  }

  private redditAgentProvider() {
    return this._integrationManager.getSocialIntegration(
      'reddit-agent'
    ) as RedditAgentProvider;
  }

  private channelCheckResult(
    integration: Integration,
    status: ChannelCheckStatus,
    message: string,
    verified: boolean
  ): ChannelCheckResult {
    return {
      id: integration.id,
      name: integration.name,
      identifier: integration.providerIdentifier,
      status,
      message,
      verified,
    };
  }

  private async checkMetaChannel(integration: Integration) {
    const version = process.env.FACEBOOK_GRAPH_API_VERSION || 'v26.0';
    const accessToken = metaChannelAccessToken(
      integration.providerIdentifier,
      integration.token
    );
    const response = await fetch(
      `https://graph.facebook.com/${version}/${encodeURIComponent(
        integration.internalId
      )}?fields=id,name,username`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(20_000),
      }
    );
    const result = await response.json().catch(() => ({}));
    if (response.ok && result?.id) {
      return this.channelCheckResult(
        integration,
        'working',
        'The provider accepted the saved access token.',
        true
      );
    }

    const authFailure =
      response.status === 401 ||
      result?.error?.code === 102 ||
      result?.error?.code === 190;
    if (authFailure) {
      return this.channelCheckResult(
        integration,
        'reconnect_required',
        'The saved access token is expired or was revoked. Reconnect this channel.',
        true
      );
    }

    return this.channelCheckResult(
      integration,
      'failed',
      `The provider health check failed${
        response.status ? ` (HTTP ${response.status})` : ''
      }. Try again before reconnecting.`,
      true
    );
  }

  private async checkRefreshableChannel(integration: Integration) {
    if (!integration.refreshToken) {
      return this.channelCheckResult(
        integration,
        'reconnect_required',
        'No refresh credential is stored. Reconnect this channel.',
        true
      );
    }

    const provider = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );
    let clientInformation:
      | { client_id: string; client_secret: string; instanceUrl: string }
      | undefined;
    if (provider.customOAuthCredentials && integration.customInstanceDetails) {
      try {
        clientInformation = JSON.parse(
          AuthService.fixedDecryption(integration.customInstanceDetails)
        );
      } catch {
        return this.channelCheckResult(
          integration,
          'reconnect_required',
          'The channel OAuth app credentials cannot be read. Reconnect this channel.',
          true
        );
      }
    }

    const refreshed = await provider.refreshToken(
      integration.refreshToken,
      clientInformation
    );
    if (!refreshed?.accessToken || !refreshed?.expiresIn) {
      return this.channelCheckResult(
        integration,
        'reconnect_required',
        'The provider rejected the saved refresh credential. Reconnect this channel.',
        true
      );
    }

    await this._integrationService.createOrUpdateIntegration(
      undefined,
      !!provider.oneTimeToken,
      integration.organizationId,
      integration.name,
      undefined,
      'social',
      integration.internalId,
      integration.providerIdentifier,
      refreshed.accessToken,
      refreshed.refreshToken || integration.refreshToken,
      refreshed.expiresIn
    );
    return this.channelCheckResult(
      integration,
      'working',
      'The provider refreshed and accepted the channel credentials.',
      true
    );
  }

  private async checkExistingTokenChannel(integration: Integration) {
    const provider = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );
    const result = await provider.authenticate({
      code: integration.token,
      codeVerifier: '',
      refresh: integration.internalId,
    });
    if (typeof result !== 'string') {
      return this.channelCheckResult(
        integration,
        'working',
        integration.providerIdentifier === 'chineseinla' ||
          integration.providerIdentifier === 'rednote' ||
          integration.providerIdentifier === 'reddit-agent'
          ? 'The saved browser session and cookies are authenticated.'
          : 'The provider accepted the saved credentials.',
        true
      );
    }
    const needsReconnect = reconnectMessage.test(result);
    return this.channelCheckResult(
      integration,
      needsReconnect ? 'reconnect_required' : 'failed',
      needsReconnect
        ? 'The saved session or credentials are no longer authenticated. Reconnect this channel.'
        : result,
      true
    );
  }

  private async checkChannel(integration: Integration) {
    if (integration.disabled) {
      return this.channelCheckResult(
        integration,
        'disabled',
        'This channel is disabled, so no provider request was made.',
        false
      );
    }
    if (
      integration.refreshNeeded &&
      !hasLiveChannelProbe(integration.providerIdentifier)
    ) {
      return this.channelCheckResult(
        integration,
        'reconnect_required',
        'Postiz already marked this channel for reconnection.',
        true
      );
    }

    try {
      if (existingTokenProbeProviders.has(integration.providerIdentifier)) {
        return await this.checkExistingTokenChannel(integration);
      }
      if (metaProbeProviders.has(integration.providerIdentifier)) {
        return await this.checkMetaChannel(integration);
      }
      if (refreshProbeProviders.has(integration.providerIdentifier)) {
        return await this.checkRefreshableChannel(integration);
      }
      if (
        integration.tokenExpiration &&
        integration.tokenExpiration.getTime() <= Date.now()
      ) {
        return this.channelCheckResult(
          integration,
          'reconnect_required',
          'The stored token has expired. Reconnect this channel.',
          false
        );
      }
      return this.channelCheckResult(
        integration,
        'unverified',
        'Postiz has not marked this channel as expired, but this provider has no safe live health probe.',
        false
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const needsReconnect = reconnectMessage.test(message);
      return this.channelCheckResult(
        integration,
        needsReconnect ? 'reconnect_required' : 'failed',
        needsReconnect
          ? 'The provider rejected the saved session or credentials. Reconnect this channel.'
          : 'The live provider check failed. Try again before reconnecting.',
        true
      );
    }
  }

  @Post('/reddit-agent/login/start')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async startRedditAgentLogin(
    @GetOrgFromRequest() org: Organization,
    @Body()
    body: {
      username?: string;
      password?: string;
      profileName?: string;
      method?: 'password' | 'google' | 'apple' | 'phone' | 'email_link' | 'sso';
    }
  ) {
    try {
      return await this.redditAgentProvider().startInteractiveLogin(
        org.id,
        body
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'Unable to start Reddit browser login.'
      );
    } finally {
      body.password = '';
    }
  }

  @Get('/reddit-agent/login/status')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async getRedditAgentLoginStatus(@GetOrgFromRequest() org: Organization) {
    return await this.redditAgentProvider().getInteractiveLoginStatus(org.id);
  }

  @Get('/reddit-agent/login/viewer/:viewerId')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  getRedditAgentLoginViewer(
    @GetOrgFromRequest() org: Organization,
    @Param('viewerId') viewerId: string
  ) {
    try {
      return this.redditAgentProvider().getInteractiveLoginViewer(
        org.id,
        viewerId
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'The Reddit login viewer is unavailable.'
      );
    }
  }

  @Get('/reddit-agent/login/viewer/:viewerId/frame')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  getRedditAgentLoginFrame(
    @GetOrgFromRequest() org: Organization,
    @Param('viewerId') viewerId: string
  ) {
    try {
      return this.redditAgentProvider().getInteractiveLoginFrame(
        org.id,
        viewerId
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'The Reddit login browser is unavailable.'
      );
    }
  }

  @Post('/reddit-agent/login/viewer/:viewerId/input')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async sendRedditAgentLoginInput(
    @GetOrgFromRequest() org: Organization,
    @Param('viewerId') viewerId: string,
    @Body() input: RedditAgentBrowserInput
  ) {
    try {
      return await this.redditAgentProvider().sendInteractiveLoginInput(
        org.id,
        viewerId,
        input
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'The Reddit login browser rejected the input.'
      );
    }
  }

  @Post('/reddit-agent/login/cancel')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async cancelRedditAgentLogin(@GetOrgFromRequest() org: Organization) {
    return await this.redditAgentProvider().cancelInteractiveLogin(org.id);
  }

  @Post('/reddit-agent/login/otp')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async submitRedditAgentLoginCode(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { code?: string }
  ) {
    try {
      return await this.redditAgentProvider().submitInteractiveLoginCode(
        org.id,
        typeof body.code === 'string' ? body.code.trim() : ''
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'Unable to submit the Reddit verification code.'
      );
    } finally {
      body.code = '';
    }
  }

  @Get('/chineseinla/egress/status')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  chineseInLAEgressStatus(@GetOrgFromRequest() org: Organization) {
    return this._egressRelayService.status(org.id);
  }

  @Post('/chineseinla/egress/ensure')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async ensureChineseInLAEgress(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { deviceId?: string }
  ) {
    try {
      return await this._egressRelayService.ensureChineseInLALease(
        org.id,
        typeof body.deviceId === 'string' && body.deviceId.trim()
          ? body.deviceId.trim()
          : undefined,
        10
      );
    } catch (error) {
      throw new BadRequestException({
        code: 'CHINESEINLA_PROXY_UNAVAILABLE',
        retryable: true,
        message:
          error instanceof Error
            ? error.message
            : 'The local ChineseInLA egress connection is unavailable.',
      });
    }
  }

  @Post('/chineseinla/login')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async loginChineseInLA(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body()
    body: {
      username?: string;
      password?: string;
      binaryPath?: string;
      mcpEndpoint?: string;
      profileName?: string;
      deviceId?: string;
    }
  ) {
    const username =
      typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || username.length > 40) {
      throw new BadRequestException(
        'ChineseInLA username is required and must be 40 characters or fewer.'
      );
    }
    if (!password || password.length > 32) {
      throw new BadRequestException(
        'ChineseInLA password is required and must be 32 characters or fewer.'
      );
    }

    try {
      await this._egressRelayService.ensureChineseInLALease(
        org.id,
        typeof body.deviceId === 'string' && body.deviceId.trim()
          ? body.deviceId.trim()
          : undefined,
        10
      );
      return await this.chineseInLAProvider().loginWithPassword(
        `${org.id}\0${user.id}`,
        {
          binaryPath: body.binaryPath,
          mcpEndpoint: body.mcpEndpoint,
          profileName: username,
        },
        username,
        password
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'Unable to sign in to ChineseInLA.'
      );
    } finally {
      body.password = '';
    }
  }

  private async connectedChineseInLA(orgId: string, integrationId: string) {
    const integration = await this._integrationService.getIntegrationById(
      orgId,
      integrationId
    );
    if (!integration || integration.providerIdentifier !== 'chineseinla') {
      throw new BadRequestException('ChineseInLA channel was not found.');
    }
    if (integration.disabled || integration.refreshNeeded) {
      throw new BadRequestException(
        'Reconnect the ChineseInLA channel before publishing.'
      );
    }
    return integration;
  }

  @Get('/chineseinla/:integrationId/forums')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async getChineseInLAForums(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string
  ) {
    const integration = await this.connectedChineseInLA(org.id, integrationId);
    try {
      return {
        forums: await this.chineseInLAProvider().listForums(integration.token),
      };
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'Unable to load ChineseInLA forums.'
      );
    }
  }

  @Post('/chineseinla/prepare')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async prepareChineseInLAPost(
    @GetOrgFromRequest() org: Organization,
    @Body()
    body: {
      integrationId?: string;
      settings?: {
        forumId?: number;
        postType?: 'question' | 'classified' | 'other';
        title?: string;
        tags?: string;
        sourceUrl?: string;
      };
      value?: Array<{
        content?: string;
        media?: Array<{ path?: string; type?: string }>;
      }>;
    }
  ) {
    if (!body.integrationId) {
      throw new BadRequestException('ChineseInLA integration ID is required.');
    }
    const integration = await this.connectedChineseInLA(
      org.id,
      body.integrationId
    );
    try {
      return await this.chineseInLAProvider().preparePost(
        integration.token,
        body.settings as any,
        body.value || []
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'Unable to prepare the ChineseInLA post.'
      );
    }
  }

  @Post('/rednote/login/start')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async startRedNoteLogin(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body()
    body: {
      binaryPath?: string;
      mcpEndpoint?: string;
      profileName?: string;
    }
  ) {
    try {
      return await this.redNoteProvider().startInteractiveLogin(
        `${org.id}\0${user.id}`,
        body
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'Unable to start RedNote login.'
      );
    }
  }

  @Get('/rednote/login/status')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async getRedNoteLoginStatus(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User
  ) {
    return await this.redNoteProvider().getInteractiveLoginStatus(
      `${org.id}\0${user.id}`
    );
  }

  @Post('/rednote/login/otp')
  @Header('Cache-Control', 'no-store, private')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async submitRedNoteLoginCode(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: { code?: string }
  ) {
    try {
      return await this.redNoteProvider().submitInteractiveLoginCode(
        `${org.id}\0${user.id}`,
        typeof body.code === 'string' ? body.code.trim() : ''
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'Unable to submit the RedNote verification code.'
      );
    }
  }

  @Post('/rednote/mcp/start')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async startRedNoteMcp(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body()
    body: {
      binaryPath?: string;
      mcpEndpoint?: string;
      profileName?: string;
    }
  ) {
    try {
      return await this.redNoteProvider().startMcpForSetup(
        `${org.id}\0${user.id}`,
        body
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Unable to start RedNote MCP.'
      );
    }
  }

  @Post('/provider/:id/connect')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async saveProviderPage(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: any
  ) {
    return this._integrationService.saveProviderPage(org.id, id, body);
  }

  @Get('/:identifier/internal-plugs')
  getInternalPlugs(@Param('identifier') identifier: string) {
    return this._integrationManager.getInternalPlugs(identifier);
  }

  @Get('/customers')
  getCustomers(@GetOrgFromRequest() org: Organization) {
    return this._integrationService.customers(org.id);
  }

  @Put('/:id/group')
  async updateIntegrationGroup(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { group: string }
  ) {
    return this._integrationService.updateIntegrationGroup(
      org.id,
      id,
      body.group
    );
  }

  @Put('/:id/customer-name')
  async updateOnCustomerName(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { name: string }
  ) {
    return this._integrationService.updateOnCustomerName(org.id, id, body.name);
  }

  @Get('/list')
  async getIntegrationList(@GetOrgFromRequest() org: Organization) {
    return {
      integrations: await Promise.all(
        (
          await this._integrationService.getIntegrationsList(org.id)
        ).map(async (p) => {
          const findIntegration = this._integrationManager.getSocialIntegration(
            p.providerIdentifier
          );
          return {
            name: p.name,
            id: p.id,
            internalId: p.internalId,
            disabled: p.disabled,
            editor: findIntegration.editor,
            stripLinks: !!findIntegration?.stripLinks?.(),
            picture: p.picture || '/no-picture.jpg',
            identifier: p.providerIdentifier,
            inBetweenSteps: p.inBetweenSteps,
            refreshNeeded: p.refreshNeeded,
            isCustomFields: !!findIntegration.customFields,
            ...(findIntegration.customFields
              ? { customFields: await findIntegration.customFields() }
              : {}),
            display: p.profile,
            type: p.type,
            time: JSON.parse(p.postingTimes),
            changeProfilePicture: !!findIntegration?.changeProfilePicture,
            changeNickName: !!findIntegration?.changeNickname,
            customer: p.customer,
            additionalSettings: p.additionalSettings || '[]',
          };
        })
      ),
    };
  }

  @Post('/check-all')
  @Header('Cache-Control', 'no-store, private')
  async checkAllChannels(@GetOrgFromRequest() org: Organization) {
    const integrations = await this._integrationService.getIntegrationsList(
      org.id
    );
    const results: ChannelCheckResult[] = new Array(integrations.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(3, integrations.length) },
      async () => {
        while (nextIndex < integrations.length) {
          const index = nextIndex++;
          const integration = integrations[index];
          const result = await this.checkChannel(integration);
          results[index] = result;
          if (
            result.status === 'reconnect_required' &&
            !integration.refreshNeeded
          ) {
            await this._integrationService.refreshNeeded(
              org.id,
              integration.id
            );
          } else if (result.status === 'working' && integration.refreshNeeded) {
            await this._integrationService.clearRefreshNeeded(
              org.id,
              integration.id
            );
          }
        }
      }
    );
    await Promise.all(workers);

    return {
      checkedAt: new Date().toISOString(),
      results,
    };
  }

  @Post('/:id/settings')
  async updateProviderSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body('additionalSettings') body: string
  ) {
    if (typeof body !== 'string') {
      throw new Error('Invalid body');
    }

    await this._integrationService.updateProviderSettings(org.id, id, body);
  }
  @Post('/:id/nickname')
  async setNickname(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { name: string; picture: string }
  ) {
    const integration = await this._integrationService.getIntegrationById(
      org.id,
      id
    );
    if (!integration) {
      throw new Error('Invalid integration');
    }

    const manager = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );
    if (!manager.changeProfilePicture && !manager.changeNickname) {
      throw new Error('Invalid integration');
    }

    const { url } = manager.changeProfilePicture
      ? await manager.changeProfilePicture(
          integration.internalId,
          integration.token,
          body.picture
        )
      : { url: '' };

    const { name } = manager.changeNickname
      ? await manager.changeNickname(
          integration.internalId,
          integration.token,
          body.name
        )
      : { name: '' };

    return this._integrationService.updateNameAndUrl(id, name, url);
  }

  @Get('/:id')
  getSingleIntegration(
    @Param('id') id: string,
    @Query('order') order: string,
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() org: Organization
  ) {
    return this._integrationService.getIntegrationForOrder(
      id,
      order,
      user.id,
      org.id
    );
  }

  @Get('/social/:integration')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async getIntegrationUrl(
    @Param('integration') integration: string,
    @Query('refresh') refresh: string,
    @Query('externalUrl') externalUrl: string,
    @Query('redirectUrl') redirectUrl: string,
    @Query('onboarding') onboarding: string,
    @GetOrgFromRequest() org: Organization
  ) {
    if (
      !this._integrationManager
        .getAllowedSocialsIntegrations()
        .includes(integration)
    ) {
      throw new Error('Integration not allowed');
    }

    // A provider migrated via MIGRATE_PROVIDERS reconnects through its target
    // provider's OAuth: the callback lands on the target and the channel is
    // migrated in place (see migrateIntegration).
    const migrateTo = refresh
      ? this._integrationManager.getMigrationTarget(integration)
      : undefined;

    const integrationProvider = this._integrationManager.getSocialIntegration(
      migrateTo || integration
    );

    if (integrationProvider.externalUrl && !externalUrl) {
      throw new Error('Missing external url');
    }

    try {
      const getExternalUrl = integrationProvider.externalUrl
        ? {
            ...(await integrationProvider.externalUrl(externalUrl)),
            instanceUrl: externalUrl,
          }
        : undefined;

      let customOAuthCredentials:
        | { client_id: string; client_secret: string; instanceUrl: string }
        | undefined;
      if (integrationProvider.customOAuthCredentials && refresh) {
        const existing =
          await this._integrationService.getIntegrationByInternalId(
            org.id,
            refresh
          );
        if (
          existing?.providerIdentifier === integration &&
          existing.customInstanceDetails
        ) {
          customOAuthCredentials = JSON.parse(
            AuthService.fixedDecryption(existing.customInstanceDetails)
          );
        }
      }

      const clientInformation = customOAuthCredentials || getExternalUrl;

      if (
        integrationProvider.oauthCredentialSetup &&
        !clientInformation &&
        !hasServerOAuthCredentials(integrationProvider.oauthCredentialSetup)
      ) {
        return {
          requiresOAuthCredentials: true,
          missing: missingOAuthCredentialNames(
            integrationProvider.oauthCredentialSetup
          ),
        };
      }

      const { codeVerifier, state, url } =
        await integrationProvider.generateAuthUrl(clientInformation);

      if (refresh) {
        await ioRedis.set(`refresh:${state}`, refresh, 'EX', 3600);
      }

      if (onboarding === 'true') {
        await ioRedis.set(`onboarding:${state}`, 'true', 'EX', 3600);
      }

      if (redirectUrl) {
        await ioRedis.set(`redirect:${state}`, redirectUrl, 'EX', 3600);
      }

      await ioRedis.set(`organization:${state}`, org.id, 'EX', 3600);
      await ioRedis.set(`login:${state}`, codeVerifier, 'EX', 3600);
      if (getExternalUrl) {
        await ioRedis.set(
          `external:${state}`,
          JSON.stringify(getExternalUrl),
          'EX',
          3600
        );
      }
      if (customOAuthCredentials) {
        await ioRedis.set(
          `customOAuth:${state}`,
          AuthService.fixedEncryption(JSON.stringify(customOAuthCredentials)),
          'EX',
          3600
        );
      }

      return { url };
    } catch (err) {
      return { err: true };
    }
  }

  @Post('/social/:integration/custom-oauth')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async getCustomOAuthIntegrationUrl(
    @Param('integration') integration: string,
    @Body()
    body: {
      clientId?: string;
      clientSecret?: string;
      redirectUrl?: string;
      onboarding?: boolean;
    },
    @GetOrgFromRequest() org: Organization
  ) {
    if (
      !this._integrationManager
        .getAllowedSocialsIntegrations()
        .includes(integration)
    ) {
      throw new BadRequestException('Integration not allowed');
    }

    const integrationProvider =
      this._integrationManager.getSocialIntegration(integration);
    if (
      !integrationProvider.customOAuthCredentials ||
      !integrationProvider.oauthCredentialSetup
    ) {
      throw new BadRequestException(
        'This integration does not support custom OAuth credentials'
      );
    }

    const clientId = body.clientId?.trim() || '';
    const clientSecret = body.clientSecret?.trim() || '';
    if (!/^\S{3,512}$/.test(clientId)) {
      throw new BadRequestException('Enter a valid OAuth Client ID');
    }
    if (!/^\S{8,512}$/.test(clientSecret)) {
      throw new BadRequestException('Enter a valid OAuth Client Secret');
    }

    const clientInformation = {
      client_id: clientId,
      client_secret: clientSecret,
      instanceUrl: process.env.FRONTEND_URL || '',
    };
    const credentialError =
      integrationProvider.validateCustomOAuthCredentials?.(clientInformation);
    if (credentialError) {
      throw new BadRequestException(credentialError);
    }
    const { codeVerifier, state, url } =
      await integrationProvider.generateAuthUrl(clientInformation);

    await ioRedis.set(`organization:${state}`, org.id, 'EX', 3600);
    await ioRedis.set(`login:${state}`, codeVerifier, 'EX', 3600);
    await ioRedis.set(
      `customOAuth:${state}`,
      AuthService.fixedEncryption(JSON.stringify(clientInformation)),
      'EX',
      3600
    );
    if (body.onboarding) {
      await ioRedis.set(`onboarding:${state}`, 'true', 'EX', 3600);
    }
    if (body.redirectUrl) {
      await ioRedis.set(`redirect:${state}`, body.redirectUrl, 'EX', 3600);
    }

    return { url };
  }

  @Post('/:id/time')
  async setTime(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: IntegrationTimeDto
  ) {
    return this._integrationService.setTimes(org.id, id, body);
  }

  @Post('/mentions')
  async mentions(
    @GetOrgFromRequest() org: Organization,
    @Body() body: IntegrationFunctionDto
  ) {
    const getIntegration = await this._integrationService.getIntegrationById(
      org.id,
      body.id
    );
    if (!getIntegration) {
      throw new Error('Invalid integration');
    }

    let newList: any[] | { none: true } = [];
    try {
      newList = (await this.functionIntegration(org, body)) || [];
    } catch (err) {
      console.log(err);
    }

    if (!Array.isArray(newList) && newList?.none) {
      return newList;
    }

    const list = await this._integrationService.getMentions(
      getIntegration.providerIdentifier,
      body?.data?.query
    );

    if (Array.isArray(newList) && newList.length) {
      await this._integrationService.insertMentions(
        getIntegration.providerIdentifier,
        newList
          .map((p: any) => ({
            name: p.label || '',
            username: p.id || '',
            image: p.image || '',
            doNotCache: p.doNotCache || false,
          }))
          .filter((f: any) => f.name && !f.doNotCache)
      );
    }

    return uniqBy(
      [
        ...list.map((p) => ({
          id: p.username,
          image: p.image,
          label: p.name,
        })),
        ...(newList as any[]),
      ],
      (p) => p.id
    ).filter((f) => f.label && f.id);
  }

  @Post('/function')
  async functionIntegration(
    @GetOrgFromRequest() org: Organization,
    @Body() body: IntegrationFunctionDto
  ): Promise<any> {
    const getIntegration = await this._integrationService.getIntegrationById(
      org.id,
      body.id
    );
    if (!getIntegration) {
      throw new Error('Invalid integration');
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );
    if (!integrationProvider) {
      throw new Error('Invalid provider');
    }

    // @ts-ignore
    if (integrationProvider[body.name]) {
      try {
        // @ts-ignore
        const load = await integrationProvider[body.name](
          getIntegration.token,
          body.data,
          getIntegration.internalId,
          getIntegration
        );

        return load;
      } catch (err) {
        // The platform will keep rejecting this channel until the user
        // re-connects it: mark it as needing a refresh instead of retrying.
        if (err instanceof Disconnect) {
          await this._integrationService.disconnectChannel(
            org.id,
            getIntegration
          );
          return false;
        }

        if (err instanceof RefreshToken) {
          const data = await this._refreshIntegrationService.refresh(
            getIntegration
          );

          if (!data) {
            return;
          }

          const { accessToken } = data;

          if (accessToken) {
            if (integrationProvider.refreshWait) {
              await timer(10000);
            }
            return this.functionIntegration(org, body);
          }

          return false;
        }

        return false;
      }
    }
    throw new Error('Function not found');
  }

  @Post('/disable')
  disableChannel(
    @GetOrgFromRequest() org: Organization,
    @Body('id') id: string
  ) {
    return this._integrationService.disableChannel(org.id, id);
  }

  @Post('/enable')
  enableChannel(
    @GetOrgFromRequest() org: Organization,
    @Body('id') id: string
  ) {
    return this._integrationService.enableChannel(
      org.id,
      // @ts-ignore
      org?.subscription?.totalChannels || pricing.FREE.channel,
      id
    );
  }

  @Delete('/')
  async deleteChannel(
    @GetOrgFromRequest() org: Organization,
    @Body('id') id: string
  ) {
    const isTherePosts = await this._integrationService.getPostsForChannel(
      org.id,
      id
    );
    if (isTherePosts.length) {
      for (const post of isTherePosts) {
        this._postService.deletePost(org.id, post.group).catch((err) => {});
      }
    }

    return this._integrationService.deleteChannel(org.id, id);
  }

  @Get('/plug/list')
  async getPlugList() {
    return { plugs: this._integrationManager.getAllPlugs() };
  }

  @Get('/:id/plugs')
  async getPlugsByIntegrationId(
    @Param('id') id: string,
    @GetOrgFromRequest() org: Organization
  ) {
    return this._integrationService.getPlugsByIntegrationId(org.id, id);
  }

  @Post('/:id/plugs')
  async postPlugsByIntegrationId(
    @Param('id') id: string,
    @GetOrgFromRequest() org: Organization,
    @Body() body: PlugDto
  ) {
    return this._integrationService.createOrUpdatePlug(org.id, id, body);
  }

  @Put('/plugs/:id/activate')
  async changePlugActivation(
    @Param('id') id: string,
    @GetOrgFromRequest() org: Organization,
    @Body('status') status: boolean
  ) {
    return this._integrationService.changePlugActivation(org.id, id, status);
  }

  @Get('/telegram/updates')
  async getUpdates(@Query() query: { word: string; id?: number }) {
    return new TelegramProvider().getBotId(query);
  }

  @Post('/moltbook/register')
  async moltbookRegister(@Body() body: { name: string; description: string }) {
    try {
      const provider = new MoltbookProvider();
      const result = await provider.registerAgent(body.name, body.description);
      return {
        apiKey: result.api_key,
        claimUrl: result.claim_url,
        verificationCode: result.verification_code,
      };
    } catch (err: any) {
      return { error: err.message || 'Registration failed' };
    }
  }

  @Get('/moltbook/status')
  async moltbookStatus(@Query('apiKey') apiKey: string) {
    try {
      const provider = new MoltbookProvider();
      const result = await provider.checkAgentStatus(apiKey);
      return { claimed: result?.status === 'claimed' };
    } catch (err) {
      return { claimed: false };
    }
  }
}
