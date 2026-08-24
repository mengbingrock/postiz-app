'use client';

import { FC } from 'react';
import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { RedNoteDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/rednote.dto';
import { Checkbox } from '@gitroom/react/form/checkbox';
import { Input } from '@gitroom/react/form/input';
import { Select } from '@gitroom/react/form/select';

const RedNoteSettings: FC = () => {
  const form = useSettings();
  return (
    <div className="flex flex-col gap-[12px]">
      <Input
        label="RedNote title"
        placeholder="20 title units maximum"
        {...form.register('title')}
      />
      <Input
        label="Topics (comma separated)"
        placeholder="加州法律, 商业诉讼"
        {...form.register('tags')}
      />
      <Select
        label="Visibility"
        {...form.register('visibility', { value: '公开可见' })}
      >
        <option value="公开可见">Public</option>
        <option value="仅自己可见">Only me</option>
        <option value="仅互关好友可见">Mutual followers</option>
      </Select>
      <Checkbox
        variant="hollow"
        label="Declare as original content"
        {...form.register('original', { value: false })}
      />
      <p className="text-[12px] text-textColor opacity-70">
        Attach one or more images, or one video. Publishing uses the signed-in
        local Xiaohongshu MCP binary configured for this channel.
      </p>
    </div>
  );
};

export default withProvider<RedNoteDto>({
  comments: false,
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: RedNoteSettings,
  CustomPreviewComponent: undefined,
  dto: RedNoteDto,
  maximumCharacters: 1000,
});
