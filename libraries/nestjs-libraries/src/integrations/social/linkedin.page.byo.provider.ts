import { LinkedinPageProvider } from '@gitroom/nestjs-libraries/integrations/social/linkedin.page.provider';
import { ClientInformation } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

/** LinkedIn Page OAuth using credentials supplied by the Postiz operator. */
export class LinkedinPageByoProvider extends LinkedinPageProvider {
  override identifier = 'linkedin-page-byo';
  override name = 'LinkedIn Page (Own App)';
  customOAuthCredentials = true;
  toolTip =
    'Connect a LinkedIn Company Page with your own approved developer app.';
  override scopes = [
    'openid',
    'profile',
    'email',
    'rw_organization_admin',
    'w_organization_social',
    'r_organization_social',
  ];

  validateCustomOAuthCredentials(clientInformation: ClientInformation) {
    if (!/^[A-Za-z0-9_-]{5,128}$/.test(clientInformation.client_id)) {
      return 'Enter a valid LinkedIn Client ID';
    }
    if (!/^\S{8,512}$/.test(clientInformation.client_secret)) {
      return 'Enter a valid LinkedIn Client Secret';
    }
    return undefined;
  }
}
