'use client';

import { FC } from 'react';
import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { TajimaWebsiteDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/tajima.website.dto';
import { Input } from '@gitroom/react/form/input';
import { Select } from '@gitroom/react/form/select';
import { Textarea } from '@gitroom/react/form/textarea';
import { MediaComponent } from '@gitroom/frontend/components/media/media.component';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';

const TajimaWebsiteSettings: FC = () => {
  const form = useSettings();
  return (
    <>
      <Input label="Article title" {...form.register('title')} />
      <Input
        label="URL slug (optional)"
        placeholder="generated-from-the-title"
        {...form.register('slug')}
      />
      <Select
        label="Author"
        {...form.register('author', { value: 'chase-tajima' })}
      >
        <option value="chase-tajima">Chase Tajima</option>
        <option value="jackie-levien">Jackie Levien</option>
        <option value="ryan-duckett">Ryan C.C. Duckett</option>
        <option value="lisa-dale">Lisa Dale</option>
        <option value="patrick-yoo">Patrick Yoo</option>
        <option value="david-song">David Song</option>
        <option value="tajima-llp">Tajima LLP</option>
      </Select>
      <Input
        label="Categories (comma separated)"
        placeholder="Business Litigation, Litigation Strategy"
        {...form.register('categories')}
      />
      <Textarea
        label="SEO description and blog excerpt"
        placeholder="Use 50–160 characters when possible."
        {...form.register('description')}
      />
      <MediaComponent
        label="Article cover image"
        description="Optional. The image will be stored with the article in the Tajima website repository."
        {...form.register('main_image')}
      />
    </>
  );
};

export default withProvider({
  comments: false,
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: TajimaWebsiteSettings,
  CustomPreviewComponent: undefined,
  dto: TajimaWebsiteDto,
  maximumCharacters: 100000,
});
