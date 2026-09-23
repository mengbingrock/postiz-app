import {
  AuthTokenDetails,
  ChannelProbeResult,
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
import { resolveOAuthCredentials } from '@gitroom/nestjs-libraries/integrations/social/oauth.credential.setup';
import { Integration } from '@prisma/client';
import { timer } from '@gitroom/helpers/utils/timer';

// Base for "<platform> (via Postiz Cloud)" channels: a platform that needs an
// audited/approved app (TikTok, Google Business Profile, …) is published
// through the channel connected in a Postiz Cloud account instead of an app of
// our own. The user authorizes this instance via Postiz's OAuth2
// (docs.postiz.com/public-api/oauth) — or, with a server-wide token, sees no
// cloud at all — and we drive the cloud Public API with the resulting token.

const cloudFrontendUrl = () =>
  (
    process.env.POSTIZ_CLOUD_FRONTEND_URL || 'https://platform.postiz.com'
  ).replace(/\/$/, '');
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
// Posts created through the cloud API are looked up again by id inside this
// window around their creation time.
const STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PostizCloudChannelSpec = {
  identifier: string; // our provider identifier, e.g. tiktok-cloud
  name: string; // tile label
  channelLabel: string; // how the platform is called in messages
  cloudIdentifiers: string[]; // cloud provider identifiers that qualify
  inviteIdentifier: string; // cloud provider used for the invite link
  toolTip: string;
  // Cloud provider identifiers that apply a custom video cover. A subset of
  // cloudIdentifiers, because two cloud channels behind the same tile do not
  // necessarily both support one. Omit when none of them do.
  coverCloudIdentifiers?: string[];
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

const formatQueryDate = (date: Date) =>
  date.toISOString().replace(/\.\d{3}Z$/, '');

export const postizCloudOAuthCredentialSetup = (
  spec: PostizCloudChannelSpec
): OAuthCredentialSetup => ({
  clientIdEnv: ['POSTIZ_CLOUD_CLIENT_ID'],
  clientSecretEnv: ['POSTIZ_CLOUD_CLIENT_SECRET'],
  clientIdLabel: 'Postiz Cloud OAuth Client ID (pca_…)',
  clientSecretLabel: 'Postiz Cloud OAuth Client Secret (pcs_…)',
  developerPortalUrl: 'https://platform.postiz.com/settings',
  documentationUrl: 'https://docs.postiz.com/public-api/oauth',
  callbackPath: `/integrations/social/${spec.identifier}`,
  help: [
    `Sign in to platform.postiz.com and connect the ${spec.channelLabel} account there first (Add channel → ${spec.channelLabel}). Postiz Cloud uses an approved app, so publishing works without your own developer app.`,
    'In Postiz Cloud open Settings → Developers → Apps → Create OAuth App and register the redirect URL shown below.',
    `Paste the app’s Client ID (pca_…) and Client Secret (pcs_…) here. After you approve the consent screen, pick which cloud ${spec.channelLabel} channel this channel publishes to.`,
  ],
});

export abstract class PostizCloudProvider
  extends SocialAbstract
  implements SocialProvider
{
  protected abstract readonly spec: PostizCloudChannelSpec;
  abstract maxLength(): number;

  get identifier() {
    return this.spec.identifier;
  }
  get name() {
    return this.spec.name;
  }
  get toolTip() {
    return this.spec.toolTip;
  }
  // With POSTIZ_CLOUD_TOKEN there is nothing for the user to configure.
  get customOAuthCredentials() {
    return !serverToken();
  }
  get oauthCredentialSetup() {
    return serverToken()
      ? undefined
      : postizCloudOAuthCredentialSetup(this.spec);
  }
  // The server-wide token is one cloud org for every workspace here: a cloud
  // channel one workspace linked must not be offered to the others.
  get sharedUpstreamAccount() {
    return !!serverToken();
  }
  isBetweenSteps = true;
  scopes: string[] = [];
  editor = 'normal' as const;
  override maxConcurrentJob = 5;

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
      postizCloudOAuthCredentialSetup(this.spec),
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
      postizCloudOAuthCredentialSetup(this.spec),
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

    // The real channel identity (the cloud integration) is chosen in the
    // next step; this only carries the organization token forward.
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
    const wanted = new Set(this.spec.cloudIdentifiers);
    const channels = (await this.cloudIntegrations(accessToken)).filter(
      (integration) =>
        wanted.has(integration.identifier) && !integration.disabled
    );
    if (!channels.length) {
      throw new ChannelSetupError(
        `Your Postiz Cloud account has no ${this.spec.channelLabel} channel. Connect ${this.spec.channelLabel} at platform.postiz.com (Add channel → ${this.spec.channelLabel}) or use the invite link below, then try again.`
      );
    }
    return channels.map((integration) => ({
      id: integration.id,
      name: integration.name,
      picture: { data: { url: integration.picture || '' } },
      identifier: integration.identifier,
    }));
  }

  // The cloud's own "invite link": an authorize URL bound to the cloud
  // organization (valid one hour). Whoever opens it connects their account
  // into the cloud org without a Postiz Cloud account; the channel then
  // appears in pages().
  async inviteLink(accessToken: string) {
    const response = await this.fetch(
      `${cloudBackendUrl()}/public/v1/social/${this.spec.inviteIdentifier}`,
      { headers: this.cloudHeaders(accessToken) },
      this.identifier
    );
    const { url } = await response.json();
    if (!url) {
      throw new ChannelSetupError(
        `Postiz Cloud did not return a ${this.spec.channelLabel} invite link.`
      );
    }
    return { url, expiresInMinutes: 60 };
  }

  async fetchPageInformation(accessToken: string, data: { id: string }) {
    const page = (await this.pages(accessToken)).find((p) => p.id === data.id);
    if (!page) {
      throw new ChannelSetupError(
        `The selected ${this.spec.channelLabel} channel is no longer available in Postiz Cloud.`
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

  // Live probe for "Check all channels": the token must still be accepted by
  // the cloud and the cloud channel must still exist and be enabled.
  async checkChannel(integration: Integration): Promise<ChannelProbeResult> {
    let channels: CloudIntegration[];
    try {
      // Plain fetch: the probe needs the HTTP status to classify, and must
      // never retry or throw the workflow-oriented errors this.fetch raises.
      const response = await fetch(
        `${cloudBackendUrl()}/public/v1/integrations`,
        {
          headers: this.cloudHeaders(integration.token),
          signal: AbortSignal.timeout(20_000),
        }
      );
      if (response.status === 401 || response.status === 403) {
        return {
          status: 'reconnect_required',
          message:
            'Postiz Cloud rejected the stored token (revoked or rotated). Reconnect this channel.',
        };
      }
      if (!response.ok) {
        return {
          status: 'failed',
          message: `Postiz Cloud answered HTTP ${response.status} to the health check.`,
        };
      }
      const list = await response.json();
      channels = Array.isArray(list) ? list : [];
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Postiz Cloud did not answer.';
      return {
        status:
          error instanceof ChannelSetupError ? 'reconnect_required' : 'failed',
        message,
      };
    }
    const channel = channels.find(
      (candidate) => candidate.id === integration.internalId
    );
    if (!channel) {
      return {
        status: 'reconnect_required',
        message: `Postiz Cloud no longer lists this ${this.spec.channelLabel} channel. Reconnect it there (or via the invite link), then reconnect this channel.`,
      };
    }
    if (channel.disabled) {
      return {
        status: 'reconnect_required',
        message: `The ${this.spec.channelLabel} channel is disabled in Postiz Cloud.`,
      };
    }
    return {
      status: 'working',
      message: `Postiz Cloud accepted the token and still lists "${channel.name}" (${channel.identifier}).`,
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
    postDetails: PostDetails[],
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
        `The ${this.spec.channelLabel} channel is no longer connected in Postiz Cloud. Reconnect it there, then reconnect this channel.`
      );
    }

    const image = [];
    for (const media of firstPost?.media || []) {
      const uploaded = await this.importMedia(accessToken, media.path);
      // A cover is only honoured by some of the cloud channels behind this
      // tile. Refuse rather than publish a post whose cover was asked for and
      // silently replaced by the platform's own frame.
      if (media.thumbnail) {
        if (
          !this.spec.coverCloudIdentifiers?.includes(cloudIntegration.identifier)
        ) {
          throw new BadBody(
            this.identifier,
            '{}',
            Buffer.from('{}'),
            `The ${this.spec.channelLabel} channel connected in Postiz Cloud does not support a custom video cover.`
          );
        }
        // The cloud only publishes media hosted on its own domain, so the
        // cover has to be imported there too and referenced by its cloud path.
        const cover = await this.importMedia(accessToken, media.thumbnail);
        image.push({ ...uploaded, thumbnail: cover.path });
        continue;
      }
      image.push(uploaded);
    }

    const { __type, ...settings } = (firstPost?.settings || {}) as any;
    const body = {
      type: 'now',
      date: new Date().toISOString(),
      shortLink: false,
      tags: [] as string[],
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
    postDetails: PostDetails[],
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
      startDate: formatQueryDate(
        new Date(createdAt.getTime() - STATUS_WINDOW_MS)
      ),
      endDate: formatQueryDate(
        new Date(createdAt.getTime() + STATUS_WINDOW_MS)
      ),
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

    const post = posts.find(
      (candidate) => candidate.id === pendingData.cloudPostId
    );
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
        post.error ||
          `Postiz Cloud could not publish the post to ${this.spec.channelLabel}.`
      );
    }
    return { status: 'pending', pendingData };
  }
}
