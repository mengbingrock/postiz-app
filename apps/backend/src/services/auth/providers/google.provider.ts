import { google } from 'googleapis';
import {
  AuthProvider,
  AuthProviderAbstract,
} from '@gitroom/backend/services/auth/providers.interface';

const defaultRedirect = () =>
  process.env.GOOGLE_AUTH_REDIRECT_URI ||
  `${process.env.FRONTEND_URL}/integrations/social/youtube`;

const getClientId = () =>
  process.env.GOOGLE_AUTH_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID;

const getClientSecret = () =>
  process.env.GOOGLE_AUTH_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET;

const makeClient = (redirectUri: string) => {
  const clientId = getClientId();
  const clientSecret = getClientSecret();

  if (!clientId || !clientSecret) {
    throw new Error(
      'Google sign-in is not configured. Set GOOGLE_AUTH_CLIENT_ID and GOOGLE_AUTH_CLIENT_SECRET.'
    );
  }

  return new google.auth.OAuth2({
    clientId,
    clientSecret,
    redirectUri,
  });
};

@AuthProvider({ provider: 'GOOGLE' })
export class GoogleProvider extends AuthProviderAbstract {
  generateLink(query?: { redirect_uri?: string; state?: string }) {
    const redirectUri = query?.redirect_uri || defaultRedirect();
    return makeClient(redirectUri).generateAuthUrl({
      access_type: 'online',
      prompt: 'select_account',
      state: query?.state || 'login',
      redirect_uri: redirectUri,
      scope: [
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
    });
  }

  async getToken(code: string, redirectUri?: string) {
    const client = makeClient(redirectUri || defaultRedirect());
    const { tokens } = await client.getToken(code);
    return tokens.access_token!;
  }

  async getUser(providerToken: string) {
    const client = makeClient(defaultRedirect());
    client.setCredentials({ access_token: providerToken });
    const { data } = await google
      .oauth2({ version: 'v2', auth: client })
      .userinfo.get();

    return {
      id: data.id!,
      email: data.email!,
      emailVerified: data.verified_email === true,
    };
  }
}
