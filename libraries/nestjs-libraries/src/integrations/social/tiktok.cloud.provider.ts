import {
  AuthTokenDetails,
  ClientInformation,
  OAuthCredentialSetup,
  PendingCheckResponse,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  BadBody,
  ChannelSetupError,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { TikTokDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/tiktok.dto';
import { resolveOAuthCredentials } from '@gitroom/nestjs-libraries/integrations/social/oauth.credential.setup';
import { Integration } from '@prisma/client';
import { timer } from '@gitroom/helpers/utils/timer';

// Publishes to TikTok through a Postiz Cloud account instead of a TikTok
// developer app of our own: Postiz Cloud runs an audited TikTok app, so public
// posting works without going through TikTok's app review. The user authorizes
// this instance via Postiz's OAuth2 (docs.postiz.com/public-api/oauth) and we
// drive the cloud Public API with the resulting pos_ token.

const cloudFrontendUrl = () =>
  (process.env.POSTIZ_CLOUD_FRONTEND_URL || 'https://platform.postiz.com').replace(
    /\/$/,
    ''
  );
const cloudBackendUrl = () =>
  (process.env.POSTIZ_CLOUD_BACKEND_URL || 'https://api.postiz.com').replace(
    /\/$/,
    ''
  );

// Server-wide mode: when the instance owns a Postiz Cloud token (the cloud
// account's API key or a pos_ grant), users never see the cloud — the tile
// skips the credential window and the consent page and goes straight to the
// channel picker. The channel stores a sentinel so a rotated token in .env is
// picked up without reconnecting.
const serverToken = () => process.env.POSTIZ_CLOUD_TOKEN?.trim() || '';
const SERVER_TOKEN_CODE = 'postiz-cloud-server-token';
const SERVER_TOKEN_SENTINEL = 'postiz-cloud:server-token';

// pos_ tokens do not expire; they are revoked by the user in Postiz Cloud.
const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 365 * 100;
const TIKTOK_IDENTIFIERS = new Set(['tiktok', 'tiktok-business']);
// Posts created through the cloud API are looked up again by id inside this
// window around their creation time.
const STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;

const tiktokCloudOAuthCredentialSetup: OAuthCredentialSetup = {
  clientIdEnv: ['POSTIZ_CLOUD_CLIENT_ID'],
  clientSecretEnv: ['POSTIZ_CLOUD_CLIENT_SECRET'],
  clientIdLabel: 'Postiz Cloud OAuth Client ID (pca_…)',
  clientSecretLabel: 'Postiz Cloud OAuth Client Secret (pcs_…)',
  developerPortalUrl: 'https://platform.postiz.com/settings',
  documentationUrl: 'https://docs.postiz.com/public-api/oauth',
  callbackPath: '/integrations/social/tiktok-cloud',
  help: [
    'Sign in to platform.postiz.com and connect the TikTok account there first (Add channel → TikTok). Postiz Cloud uses an audited TikTok app, so public posting works without your own TikTok developer app.',
    'In Postiz Cloud open Settings → Developers → Apps → Create OAuth App and register the redirect URL shown below.',
    'Paste the app’s Client ID (pca_…) and Client Secret (pcs_…) here. After you approve the consent screen, pick which cloud TikTok channel this channel publishes to.',
  ],
};

type CloudIntegration = {
  id: string;
  name: string;
  identifier: string;
  picture?: string | null;
  disabled?: boolean;
  profile?: string | null;
};

type CloudPost = {
  id: string;
  state: string;
  releaseURL?: string | null;
  releaseId?: string | null;
  error?: string | null;
};

type CloudPendingData = { cloudPostId: string; createdAt: string };

const formatQueryDate = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, '');

@Rules(
  'TikTok (via Postiz Cloud) publishes through the TikTok channel connected in the user’s Postiz Cloud account; it accepts the same settings as a TikTok channel (title, privacy_level, content_posting_method, duet, stitch, comment, autoAddMusic, brand toggles, video_made_with_ai) and needs one video or one or more photos.'
)
export class TiktokCloudProvider extends SocialAbstract implements SocialProvider {
  identifier = 'tiktok-cloud';
  name = 'TikTok\n(via Postiz Cloud)';
  // With POSTIZ_CLOUD_TOKEN there is nothing for the user to configure.
  customOAuthCredentials = !serverToken();
  oauthCredentialSetup = serverToken()
    ? undefined
    : tiktokCloudOAuthCredentialSetup;
  isBetweenSteps = true;
  scopes: string[] = [];
  toolTip =
    'Publish to TikTok through your Postiz Cloud account — no TikTok developer app review needed.';
  editor = 'normal' as const;
  dto = TikTokDto;
  override maxConcurrentJob = 5;

  maxLength() {
    return 2200;
  }

  validateCustomOAuthCredentials(clientInformation: ClientInformation) {
    if (!/^pca_[A-Za-z0-9_-]{8,}$/.test(clientInformation.client_id)) {
      return 'Enter a valid Postiz Cloud Client ID (it starts with pca_)';
    }
    if (!/^pcs_[A-Za-z0-9_-]{8,}$/.test(clientInformation.client_secret)) {
      return 'Enter a valid Postiz Cloud Client Secret (it starts with pcs_)';
    }
    return undefined;
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      id: '',
      name: '',
      picture: '',
      username: '',
      accessToken: refreshToken,
      refreshToken,
      expiresIn: TOKEN_LIFETIME_SECONDS,
    };
  }

  private resolveToken(accessToken: string) {
    if (accessToken !== SERVER_TOKEN_SENTINEL) {
      return accessToken;
    }
    const token = serverToken();
    if (!token) {
      throw new ChannelSetupError(
        'This channel uses the server-wide Postiz Cloud token, but POSTIZ_CLOUD_TOKEN is no longer set on the server.'
      );
    }
    return token;
  }

  async generateAuthUrl(clientInformation?: ClientInformation) {
    const state = makeId(16);
    if (serverToken()) {
      // No consent needed: land on our own callback, which calls authenticate.
      return {
        url:
          `${process.env.FRONTEND_URL}/integrations/social/${this.identifier}` +
          `?code=${SERVER_TOKEN_CODE}&state=${state}`,
        codeVerifier: state,
        state,
      };
    }
    const credentials = resolveOAuthCredentials(
      tiktokCloudOAuthCredentialSetup,
      clientInformation
    );

    return {
      url:
        `${cloudFrontendUrl()}/oauth/authorize` +
        `?client_id=${encodeURIComponent(credentials.client_id)}` +
        `&response_type=code` +
        `&state=${state}`,
      codeVerifier: state,
      state,
    };
  }

  async authenticate(
    params: { code: string; codeVerifier: string; refresh?: string },
    clientInformation?: ClientInformation
  ) {
    if (params.code === SERVER_TOKEN_CODE) {
      if (!serverToken()) {
        return 'POSTIZ_CLOUD_TOKEN is not set on this server.';
      }
      return {
        id: 'postiz-cloud-server',
        name: 'Postiz Cloud',
        accessToken: SERVER_TOKEN_SENTINEL,
        refreshToken: SERVER_TOKEN_SENTINEL,
        expiresIn: TOKEN_LIFETIME_SECONDS,
        picture: '',
        username: '',
      };
    }
    const credentials = resolveOAuthCredentials(
      tiktokCloudOAuthCredentialSetup,
      clientInformation
    );
    const response = await this.fetch(
      `${cloudBackendUrl()}/oauth/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: params.code,
          client_id: credentials.client_id,
          client_secret: credentials.client_secret,
        }),
      },
      this.identifier
    );
    const { id, access_token } = await response.json();
    if (!access_token) {
      return 'Postiz Cloud did not return an access token.';
    }

    // The real channel identity (the cloud TikTok integration) is chosen in
    // the next step; this only carries the organization token forward.
    return {
      id: `postiz-cloud-${id || makeId(8)}`,
      name: 'Postiz Cloud',
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: TOKEN_LIFETIME_SECONDS,
      picture: '',
      username: '',
    };
  }

  private cloudHeaders(accessToken: string) {
    return {
      'Content-Type': 'application/json',
      Authorization: this.resolveToken(accessToken),
    };
  }

  private async cloudIntegrations(
    accessToken: string
  ): Promise<CloudIntegration[]> {
    const response = await this.fetch(
      `${cloudBackendUrl()}/public/v1/integrations`,
      { headers: this.cloudHeaders(accessToken) },
      this.identifier
    );
    const list = await response.json();
    return Array.isArray(list) ? list : [];
  }

  async pages(accessToken: string) {
    const tiktok = (await this.cloudIntegrations(accessToken)).filter(
      (integration) =>
        TIKTOK_IDENTIFIERS.has(integration.identifier) && !integration.disabled
    );
    if (!tiktok.length) {
      throw new ChannelSetupError(
        'Your Postiz Cloud account has no TikTok channel. Connect TikTok at platform.postiz.com (Add channel → TikTok), then try again.'
      );
    }
    return tiktok.map((integration) => ({
      id: integration.id,
      name: integration.name,
      picture: { data: { url: integration.picture || '' } },
      identifier: integration.identifier,
    }));
  }

  async fetchPageInformation(accessToken: string, data: { id: string }) {
    const page = (await this.pages(accessToken)).find((p) => p.id === data.id);
    if (!page) {
      throw new ChannelSetupError(
        'The selected TikTok channel is no longer available in Postiz Cloud.'
      );
    }
    return {
      id: page.id,
      name: page.name,
      access_token: accessToken,
      picture: page.picture.data.url,
      username: page.name,
    };
  }

  async reConnect(
    id: string,
    requiredId: string,
    accessToken: string
  ): Promise<Omit<AuthTokenDetails, 'refreshToken' | 'expiresIn'>> {
    const information = await this.fetchPageInformation(accessToken, {
      id: requiredId,
    });
    return {
      id: information.id,
      name: information.name,
      accessToken: information.access_token,
      picture: information.picture,
      username: information.username,
    };
  }

  // The cloud only publishes media hosted on its own domain, so every
  // attachment is imported there first from our public upload URL.
  private async importMedia(accessToken: string, path: string) {
    const response = await this.fetch(
      `${cloudBackendUrl()}/public/v1/upload-from-url`,
      {
        method: 'POST',
        headers: this.cloudHeaders(accessToken),
        body: JSON.stringify({ url: path }),
      },
      this.identifier
    );
    const uploaded = await response.json();
    if (!uploaded?.id || !uploaded?.path) {
      throw new BadBody(
        this.identifier,
        JSON.stringify(uploaded),
        Buffer.from(JSON.stringify({ url: path })),
        'Postiz Cloud could not import the media from this instance.'
      );
    }
    return { id: uploaded.id as string, path: uploaded.path as string };
  }

  async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails<TikTokDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const cloudIntegration = (await this.cloudIntegrations(accessToken)).find(
      (candidate) => candidate.id === integration.internalId
    );
    if (!cloudIntegration) {
      throw new BadBody(
        this.identifier,
        '{}',
        Buffer.from('{}'),
        'The TikTok channel is no longer connected in Postiz Cloud. Reconnect it there, then reconnect this channel.'
      );
    }

    const image = [];
    for (const media of firstPost?.media || []) {
      image.push(await this.importMedia(accessToken, media.path));
    }

    const { __type, ...settings } = (firstPost?.settings || {}) as any;
    const body = {
      type: 'now',
      date: new Date().toISOString(),
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: cloudIntegration.id },
          value: [{ content: firstPost?.message || '', image }],
          settings: { ...settings, __type: cloudIntegration.identifier },
        },
      ],
    };
    const response = await this.fetch(
      `${cloudBackendUrl()}/public/v1/posts`,
      {
        method: 'POST',
        headers: this.cloudHeaders(accessToken),
        body: JSON.stringify(body),
      },
      this.identifier
    );
    const created = await response.json();
    const cloudPostId = created?.[0]?.postId;
    if (!cloudPostId) {
      throw new BadBody(
        this.identifier,
        JSON.stringify(created),
        Buffer.from(JSON.stringify(body)),
        'Postiz Cloud did not accept the post.'
      );
    }

    const pendingData: CloudPendingData = {
      cloudPostId,
      createdAt: new Date().toISOString(),
    };
    return [
      {
        id: firstPost.id,
        postId: cloudPostId,
        releaseURL: '',
        status: 'pending',
        pendingData,
      },
    ];
  }

  // Older post workflows call post() and expect a final answer: submit, then
  // wait a bounded time for the cloud to publish.
  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<TikTokDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [pending] = await this.postPending(
      id,
      accessToken,
      postDetails,
      integration
    );
    for (let attempt = 0; attempt < 30; attempt++) {
      const check = await this.checkPostStatus(
        accessToken,
        pending.pendingData,
        integration
      );
      if (check.status === 'completed') {
        return [
          {
            ...pending,
            status: 'completed',
            releaseURL: check.releaseURL,
            postId: check.postId,
          },
        ];
      }
      await timer(10_000);
    }
    throw new BadBody(
      this.identifier,
      JSON.stringify(pending.pendingData),
      Buffer.from('{}'),
      `Postiz Cloud has not published the post yet; check ${cloudFrontendUrl()}/launches.`
    );
  }

  override async checkPostStatus(
    accessToken: string,
    pendingData: CloudPendingData,
    integration: Integration
  ): Promise<PendingCheckResponse> {
    const createdAt = new Date(pendingData.createdAt);
    const params = new URLSearchParams({
      startDate: formatQueryDate(new Date(createdAt.getTime() - STATUS_WINDOW_MS)),
      endDate: formatQueryDate(new Date(createdAt.getTime() + STATUS_WINDOW_MS)),
    });
    let posts: CloudPost[] = [];
    try {
      const response = await this.fetch(
        `${cloudBackendUrl()}/public/v1/posts?${params}`,
        { headers: this.cloudHeaders(accessToken) },
        '',
        0,
        true
      );
      posts = (await response.json())?.posts || [];
    } catch (error) {
      // A transient cloud error must not fail a post that may already be live.
      return { status: 'pending', pendingData };
    }

    const post = posts.find((candidate) => candidate.id === pendingData.cloudPostId);
    if (!post) {
      return { status: 'pending', pendingData };
    }
    if (post.state === 'PUBLISHED') {
      return {
        status: 'completed',
        releaseURL: post.releaseURL || `${cloudFrontendUrl()}/launches`,
        postId: post.releaseId || post.id,
      };
    }
    if (post.state === 'ERROR') {
      throw new BadBody(
        this.identifier,
        JSON.stringify(post),
        Buffer.from(JSON.stringify(pendingData)),
        post.error || 'Postiz Cloud could not publish the post to TikTok.'
      );
    }
    return { status: 'pending', pendingData };
  }
}
