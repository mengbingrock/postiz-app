import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { TikTokDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/tiktok.dto';
import {
  PostizCloudChannelSpec,
  PostizCloudProvider,
} from '@gitroom/nestjs-libraries/integrations/social/postiz.cloud.provider';

// Publishes to TikTok through a Postiz Cloud account: Postiz Cloud runs an
// audited TikTok app, so public posting works without TikTok's app review.
@Rules(
  'TikTok (via Postiz Cloud) publishes through the TikTok channel connected in the user’s Postiz Cloud account; it accepts the same settings as a TikTok channel (title, privacy_level, content_posting_method, duet, stitch, comment, autoAddMusic, brand toggles, video_made_with_ai) and needs one video or one or more photos.'
)
export class TiktokCloudProvider extends PostizCloudProvider {
  protected readonly spec: PostizCloudChannelSpec = {
    identifier: 'tiktok-cloud',
    name: 'TikTok\n(via Postiz Cloud)',
    channelLabel: 'TikTok',
    cloudIdentifiers: ['tiktok', 'tiktok-business'],
    // Only the Business API takes a custom_thumbnail_url; legacy TikTok offers
    // a frame offset instead, which is not a cover image.
    coverCloudIdentifiers: ['tiktok-business'],
    inviteIdentifier: 'tiktok-business',
    toolTip:
      'Publish to TikTok through your Postiz Cloud account — no TikTok developer app review needed.',
  };
  dto = TikTokDto;

  maxLength() {
    return 2200;
  }
}
