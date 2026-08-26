'use client';

import React, { FC, useEffect, useState } from 'react';
import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { useIntegration } from '@gitroom/frontend/components/launches/helpers/use.integration';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Input } from '@gitroom/react/form/input';
import { Select } from '@gitroom/react/form/select';
import { ChineseInLADto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/chineseinla.dto';

type Forum = {
  id: number;
  name: string;
  group?: string;
  description?: string;
  restricted: boolean;
};

const ChineseInLASettings: FC = () => {
  const form = useSettings();
  const fetch = useFetch();
  const { integration } = useIntegration();
  const [forums, setForums] = useState<Forum[]>([]);
  const [forumMessage, setForumMessage] = useState(
    'Loading the live ChineseInLA forum catalog…'
  );

  useEffect(() => {
    if (!form.getValues('postType')) {
      form.setValue('postType', 'other', { shouldValidate: true });
    }
    if (!integration?.id) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/integrations/chineseinla/${integration.id}/forums`
        );
        const data = (await response.json()) as {
          forums?: Forum[];
          message?: string | string[];
        };
        if (!response.ok || !Array.isArray(data.forums)) {
          throw new Error(
            Array.isArray(data.message)
              ? data.message.join(', ')
              : data.message || 'Unable to load ChineseInLA forums.'
          );
        }
        if (!cancelled) {
          setForums(data.forums);
          setForumMessage(
            `${data.forums.length} live forums loaded. Restricted forums remain unavailable.`
          );
        }
      } catch (error) {
        if (!cancelled) {
          setForumMessage(
            error instanceof Error
              ? error.message
              : 'Unable to load ChineseInLA forums.'
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetch, form, integration?.id]);

  return (
    <div className="flex flex-col gap-[12px]">
      <Select
        label="ChineseInLA forum"
        name="forumId"
        extraForm={{ valueAsNumber: true }}
      >
        <option value="">Select a live forum</option>
        {forums.map((forum) => (
          <option key={forum.id} value={forum.id} disabled={forum.restricted}>
            {forum.group ? `${forum.group} — ` : ''}
            {forum.name}
            {forum.restricted ? ' (restricted)' : ''}
          </option>
        ))}
      </Select>
      <p className="text-[11px] text-textColor/60">{forumMessage}</p>

      <Select label="Post type" name="postType">
        <option value="question">Question / 问题征解</option>
        <option value="classified">Classified / 分类信息</option>
        <option value="other">Other / 其他类型</option>
      </Select>

      <Input
        label="ChineseInLA title"
        name="title"
        placeholder="Recommended: 8–15 Chinese characters"
        maxLength={120}
      />
      <Input
        label="Tags (comma separated)"
        name="tags"
        placeholder="洛杉矶, 本地生活"
        maxLength={240}
      />
      <Input
        label="Source URL (optional)"
        name="sourceUrl"
        type="url"
        placeholder="https://example.com/source"
      />

      <div className="rounded-[8px] border border-orange-500/35 bg-orange-500/10 p-[12px] text-[12px] text-textColor/75">
        ChineseInLA supports immediate publishing only. When you press Publish,
        Postiz fills the forum form and shows its screenshot. Nothing is
        submitted until you review that screenshot and confirm again.
      </div>
    </div>
  );
};

export default withProvider<ChineseInLADto>({
  comments: false,
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: ChineseInLASettings,
  CustomPreviewComponent: undefined,
  dto: ChineseInLADto,
  maximumCharacters: 10_000,
});
