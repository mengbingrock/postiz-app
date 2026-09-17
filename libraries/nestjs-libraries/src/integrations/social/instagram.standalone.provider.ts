import {
  AuthTokenDetails,
  ClientInformation,
  OAuthCredentialSetup,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import dayjs from 'dayjs';
import {
  ChannelSetupError,
  SocialAbstract,
  ValidityMedia,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { InstagramDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/instagram.dto';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import { facebookApiVersion } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { Integration } from '@prisma/client';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { resolveOAuthCredentials } from '@gitroom/nestjs-libraries/integrations/social/oauth.credential.setup';

const instagramOAuthCredentialSetup: OAuthCredentialSetup = {
  clientIdEnv: ['INSTAGRAM_APP_ID'],
  clientSecretEnv: ['INSTAGRAM_APP_SECRET'],
  clientIdLabel: 'Instagram App ID',
  clientSecretLabel: 'Instagram App Secret',
  developerPortalUrl: 'https://developers.facebook.com/apps/creation/',
  documentationUrl:
    'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/',
  help: [
    'Add the Manage messaging & content on Instagram use case and open API setup with Instagram login.',
    'Use the Instagram App ID and Instagram App Secret shown on that page, not the Meta App ID.',
    'Under "Set up Instagram business login", add this redirect URL: <your Postiz URL>/integrations/social/instagram-standalone.',
    'Add the required content permissions (instagram_business_basic, instagram_business_content_publish, instagram_business_manage_comments, instagram_business_manage_insights).',
    'While the app is unpublished, add the Instagram account under "Generate access tokens" (Add account) and accept the tester invite in the Instagram app (Settings → Website permissions → Apps and websites).',
    'The Instagram account must be a Business or Creator account. It does not need a Facebook Page.',
  ],
};

const instagramProvider = new InstagramProvider();

// Meta's Instagram Login error bodies come in two shapes:
// { error_type, code, error_message } from api.instagram.com and
// { error: { message, type, code } } from graph.instagram.com.
const instagramErrorMessage = (body: any): string | undefined =>
  body?.error_message ||
  body?.error?.message ||
  (typeof body?.error === 'string' ? body.error : undefined);

@Rules(
  "Instagram should have at least one attachment, if it's a story, it can have only one picture"
)
export class InstagramStandaloneProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'instagram-standalone';
  name = 'Instagram\n(Standalone)';
  customOAuthCredentials = true;
  oauthCredentialSetup = instagramOAuthCredentialSetup;
  isBetweenSteps = false;
  refreshCron = true;
  scopes = [
    'instagram_business_basic',
    'instagram_business_content_publish',
    'instagram_business_manage_comments',
    'instagram_business_manage_insights',
  ];
  override maxConcurrentJob = 200; // Instagram standalone has stricter limits
  dto = InstagramDto;

  editor = 'normal' as const;
  maxLength() {
    return 2200;
  }

  validateCustomOAuthCredentials(clientInformation: ClientInformation) {
    if (!/^\d{5,32}$/.test(clientInformation.client_id)) {
      return 'Enter the numeric Instagram App ID (from API setup with Instagram login)';
    }
    if (!/^\S{16,256}$/.test(clientInformation.client_secret)) {
      return 'Enter a valid Instagram App Secret';
    }
    return undefined;
  }

  override async checkValidity(
    [firstPost]: Array<ValidityMedia[]>,
    settings: any
  ): Promise<string | true> {
    if (!firstPost?.length) {
      return 'Should have at least one media';
    }
    if (this.assetBoolean(settings?.is_trial_reel)) {
      if ((firstPost?.length ?? 0) > 1) {
        return 'Trial Reels can only have one video';
      }
      const hasVideo = firstPost?.some(
        (f) => (f?.path?.indexOf?.('mp4') ?? -1) > -1
      );
      if (!hasVideo) {
        return 'Trial Reels must be a video';
      }
    }
    return true;
  }

  public override handleErrors(
    body: string,
    status: number
  ):
    | { type: 'refresh-token' | 'bad-body' | 'retry'; value: string }
    | undefined {
    return instagramProvider.handleErrors(body, status);
  }

  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
    const { access_token } = await (
      await fetch(
        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${refresh_token}`
      )
    ).json();

    const {
      user_id,
      name,
      username,
      profile_picture_url = '',
    } = await (
      await fetch(
        `https://graph.instagram.com/${facebookApiVersion()}/me?fields=user_id,username,name,profile_picture_url&access_token=${access_token}`
      )
    ).json();

    return {
      id: user_id,
      name,
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: dayjs().add(58, 'days').unix() - dayjs().unix(),
      picture: profile_picture_url || '',
      username,
    };
  }

  async generateAuthUrl(clientInformation?: ClientInformation) {
    const state = makeId(6);
    const credentials = resolveOAuthCredentials(
      instagramOAuthCredentialSetup,
      clientInformation
    );
    return {
      url:
        `https://www.instagram.com/oauth/authorize?enable_fb_login=0&client_id=${
          credentials.client_id
        }&redirect_uri=${encodeURIComponent(
          `${
            process?.env.FRONTEND_URL?.indexOf('https') == -1
              ? `https://redirectmeto.com/${process?.env.FRONTEND_URL}`
              : `${process?.env.FRONTEND_URL}`
          }/integrations/social/instagram-standalone`
        )}&response_type=code&scope=${encodeURIComponent(
          this.scopes.join(',')
        )}` + `&state=${state}`,
      codeVerifier: makeId(10),
      state,
    };
  }

  async authenticate(
    params: {
      code: string;
      codeVerifier: string;
      refresh: string;
    },
    clientInformation?: ClientInformation
  ) {
    const credentials = resolveOAuthCredentials(
      instagramOAuthCredentialSetup,
      clientInformation
    );
    const formData = new FormData();
    formData.append('client_id', credentials.client_id);
    formData.append('client_secret', credentials.client_secret);
    formData.append('grant_type', 'authorization_code');
    formData.append(
      'redirect_uri',
      `${
        process?.env.FRONTEND_URL?.indexOf('https') == -1
          ? `https://redirectmeto.com/${process?.env.FRONTEND_URL}`
          : `${process?.env.FRONTEND_URL}`
      }/integrations/social/instagram-standalone`
    );
    formData.append('code', params.code);

    const getAccessToken = await (
      await fetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        body: formData,
      })
    ).json();

    // Without this the dialog only ever says "Authentication failed", while
    // Meta's body says exactly what is wrong (redirect URL not configured,
    // wrong app id, account not a tester of the unpublished app, ...).
    if (!getAccessToken?.access_token) {
      throw new ChannelSetupError(
        `Instagram rejected the login code${
          instagramErrorMessage(getAccessToken)
            ? `: ${instagramErrorMessage(getAccessToken)}`
            : ''
        }. Check that the Instagram App ID and Secret are the ones from "API setup with Instagram login", that Instagram business login lists this redirect URL, and that the Instagram account is a tester of the app while it is unpublished.`
      );
    }

    const shortLivedScopes = getAccessToken.permissions;
    const longLived = await (
      await fetch(
        'https://graph.instagram.com/access_token' +
          '?grant_type=ig_exchange_token' +
          `&client_id=${encodeURIComponent(credentials.client_id)}` +
          `&client_secret=${encodeURIComponent(credentials.client_secret)}` +
          `&access_token=${getAccessToken.access_token}`
      )
    ).json();
    const access_token = longLived?.access_token;
    if (!access_token) {
      throw new ChannelSetupError(
        `Instagram did not issue a long-lived token${
          instagramErrorMessage(longLived)
            ? `: ${instagramErrorMessage(longLived)}`
            : ''
        }.`
      );
    }

    this.checkScopes(this.scopes, shortLivedScopes ?? []);

    const profile = await (
      await fetch(
        `https://graph.instagram.com/${facebookApiVersion()}/me?fields=user_id,username,name,profile_picture_url&access_token=${access_token}`
      )
    ).json();
    const { user_id, name, username, profile_picture_url } = profile ?? {};
    if (!user_id) {
      throw new ChannelSetupError(
        `Instagram returned no profile for this token${
          instagramErrorMessage(profile)
            ? `: ${instagramErrorMessage(profile)}`
            : ''
        }. The account must be a Business or Creator account.`
      );
    }

    return {
      id: user_id,
      name,
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: dayjs().add(58, 'days').unix() - dayjs().unix(),
      picture: profile_picture_url,
      username,
    };
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.post(
      id,
      accessToken,
      postDetails,
      integration,
      'graph.instagram.com'
    );
  }

  async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.postPending(
      id,
      accessToken,
      postDetails,
      integration,
      'graph.instagram.com'
    );
  }

  // the graph domain travels inside pendingData, so these are pure delegations
  override async checkPostStatus(
    accessToken: string,
    pendingData: any,
    integration: Integration
  ) {
    return instagramProvider.checkPostStatus(
      accessToken,
      pendingData,
      integration
    );
  }

  override async finalizePost(
    accessToken: string,
    pendingData: any,
    integration: Integration
  ) {
    return instagramProvider.finalizePost(
      accessToken,
      pendingData,
      integration
    );
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.comment(
      id,
      postId,
      lastCommentId,
      accessToken,
      postDetails,
      integration,
      'graph.instagram.com'
    );
  }

  async analytics(id: string, accessToken: string, date: number) {
    return instagramProvider.analytics(
      id,
      accessToken,
      date,
      'graph.instagram.com'
    );
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ) {
    return instagramProvider.postAnalytics(
      integrationId,
      accessToken,
      postId,
      date,
      'graph.instagram.com'
    );
  }
}
