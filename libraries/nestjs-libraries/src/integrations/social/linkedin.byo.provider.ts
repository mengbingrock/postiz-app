import { ClientInformation } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { LinkedinProvider } from '@gitroom/nestjs-libraries/integrations/social/linkedin.provider';

/** Personal-profile LinkedIn OAuth using the connecting customer's app. */
export class LinkedinByoProvider extends LinkedinProvider {
  override identifier = 'linkedin-byo';
  override name = 'LinkedIn Personal (Own App)';
  override scopes = ['openid', 'profile', 'w_member_social'];
  customOAuthCredentials = true;
  toolTip =
    'Connect your personal LinkedIn profile with a developer app you control.';

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
