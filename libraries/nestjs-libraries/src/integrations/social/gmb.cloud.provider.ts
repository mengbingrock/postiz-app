import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { GmbSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/gmb.settings.dto';
import {
  PostizCloudChannelSpec,
  PostizCloudProvider,
} from '@gitroom/nestjs-libraries/integrations/social/postiz.cloud.provider';

// Publishes to a Google Business Profile location through a Postiz Cloud
// account: the cloud's Google app already has Business Profile API access and
// quota, so no Cloud project / API enablement / quota request of our own.
@Rules(
  'Google Business (via Postiz Cloud) publishes through the Google Business Profile location connected in the user’s Postiz Cloud account; same settings as Google My Business (topicType STANDARD/EVENT/OFFER, call to action, event and offer fields). Posts can be text only or text with one image.'
)
export class GmbCloudProvider extends PostizCloudProvider {
  protected readonly spec: PostizCloudChannelSpec = {
    identifier: 'gmb-cloud',
    name: 'Google Business\n(via Postiz Cloud)',
    channelLabel: 'Google Business Profile',
    cloudIdentifiers: ['gmb'],
    inviteIdentifier: 'gmb',
    toolTip:
      'Publish to a Google Business Profile location through your Postiz Cloud account — no Google Cloud project or API quota approval needed.',
  };
  dto = GmbSettingsDto;

  maxLength() {
    return 1500;
  }
}
