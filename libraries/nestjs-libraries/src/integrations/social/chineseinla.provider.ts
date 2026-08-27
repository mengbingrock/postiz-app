import { createHash } from 'node:crypto';
import { Integration } from '@prisma/client';
import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  McpToolResult,
  RedNoteCredentials,
  RedNoteProvider,
} from '@gitroom/nestjs-libraries/integrations/social/rednote.provider';
import { ChineseInLADto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/chineseinla.dto';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';

type ChineseInLALoginSession = {
  session_id: string;
  state:
    | 'waiting_for_credentials'
    | 'submitting'
    | 'invalid_credentials'
    | 'captcha_required'
    | 'authenticated'
    | 'expired'
    | 'failed';
  logged_in: boolean;
  message: string;
  expires_at?: string;
  attempts?: number;
};

type ChineseInLALoginStatus = {
  logged_in: boolean;
  message?: string;
  url?: string;
};

type ChineseInLAForum = {
  id: number;
  name: string;
  groupId?: number;
  group?: string;
  description?: string;
  restricted: boolean;
};

type ChineseInLAForumWire = Omit<ChineseInLAForum, 'groupId'> & {
  group_id?: number;
};

type ChineseInLAForumResponse = {
  status: string;
  count: number;
  forums: ChineseInLAForumWire[];
};

type ChineseInLAForumPostWire = {
  topic_id: number;
  url: string;
  title: string;
  author?: string;
  author_id?: number;
  updated_at?: string;
  reply_count: number;
  view_count: number;
  has_images: boolean;
  highlighted: boolean;
};

type ChineseInLAListPostsResponse = {
  status: string;
  category_id: number;
  forum: ChineseInLAForumWire;
  page: number;
  page_size: number;
  has_next: boolean;
  posts: ChineseInLAForumPostWire[];
};

type ChineseInLATopicMessageWire = {
  post_id?: number;
  floor: number;
  author?: string;
  author_id?: number;
  published_at?: string;
  updated_at?: string;
  body: string;
  image_urls?: string[];
};

type ChineseInLAReadPostResponse = {
  status: string;
  category_id: number;
  forum: ChineseInLAForumWire;
  topic_id: number;
  url: string;
  title: string;
  page: number;
  page_size: number;
  has_next: boolean;
  messages: ChineseInLATopicMessageWire[];
};

type ChineseInLAPrepareResponse = {
  status: string;
  draft_id: string;
  forum: ChineseInLAForumWire;
  post_type: string;
  post_type_name: string;
  title: string;
  image_count: number;
  warnings?: string[];
  message: string;
};

type ChineseInLAPublishResponse = {
  status: string;
  topic_url: string;
  message: string;
};

const DEFAULT_MCP_ENDPOINT = 'http://127.0.0.1:18060/mcp';
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

export const chineseInLAPostizContentToText = (content: string) =>
  stripHtmlValidation(
    'normal',
    content
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|h[1-6]|li|ul|ol)>/gi, '$&\n'),
    false,
    true
  )
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export class ChineseInLAProvider
  extends RedNoteProvider
  implements SocialProvider
{
  override identifier = 'chineseinla';
  override name = 'ChineseInLA';
  override editor = 'normal' as const;
  override dto = ChineseInLADto;

  override maxLength() {
    return 10_000;
  }

  private parseJson<T>(text: string, operation: string): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`ChineseInLA returned an invalid ${operation} response.`);
    }
  }

  private screenshot(result: McpToolResult) {
    const image = result.content.find(
      (item) => item.type === 'image' && item.data
    );
    if (!image?.data) {
      return undefined;
    }

    const mimeType = image.mimeType || 'image/png';
    if (!['image/png', 'image/jpeg'].includes(mimeType)) {
      return undefined;
    }
    const base64 = image.data.replace(/\s/g, '');
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
      Buffer.from(base64, 'base64').byteLength > MAX_SCREENSHOT_BYTES
    ) {
      return undefined;
    }
    return `data:${mimeType};base64,${base64}`;
  }

  async loginWithPassword(
    value: Partial<RedNoteCredentials> | undefined,
    username: string,
    password: string
  ) {
    const credentials = this.setupCredentials(value);
    try {
      const existingLogin = this.parseJson<ChineseInLALoginStatus>(
        await this.callMcpTool(
          credentials,
          'chineseinla_check_login',
          {},
          90_000
        ),
        'login status'
      );
      if (existingLogin.logged_in) {
        password = '';
        return {
          success: true,
          state: 'authenticated' as const,
          message:
            'ChineseInLA is already authenticated. Postiz reused the isolated browser cookie without submitting the entered password.',
        };
      }
    } catch {
      // A status probe should not prevent a logged-out account from entering
      // the normal retained-page credential flow below.
    }

    const opened = await this.callMcpToolResult(
      credentials,
      'chineseinla_open_login',
      {},
      60_000
    );
    let session = this.parseJson<ChineseInLALoginSession>(
      opened.text,
      'login session'
    );

    if (!session.logged_in) {
      if (!session.session_id) {
        throw new Error('ChineseInLA did not return a login session ID.');
      }
      const submitted = await this.callMcpToolResult(
        credentials,
        'chineseinla_submit_login_password',
        {
          session_id: session.session_id,
          username,
          password,
        },
        90_000
      );
      session = this.parseJson<ChineseInLALoginSession>(
        submitted.text,
        'credential submission'
      );
      password = '';

      if (!session.logged_in || session.state !== 'authenticated') {
        return {
          success: false,
          state: session.state,
          message:
            session.message ||
            'ChineseInLA did not complete login. Check the credentials and try again.',
          attempts: session.attempts || 0,
          screenshot: this.screenshot(submitted),
        };
      }
    }

    return {
      success: true,
      state: 'authenticated' as const,
      message:
        'ChineseInLA login succeeded. The isolated browser cookie is ready for Postiz.',
    };
  }

  override async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }): Promise<AuthTokenDetails | string> {
    try {
      const credentials = this.decodeCredentials(params.code);
      const output = await this.callMcpTool(
        credentials,
        'chineseinla_check_login',
        {},
        90_000
      );
      const status = this.parseJson<ChineseInLALoginStatus>(
        output,
        'login status'
      );
      if (!status.logged_in) {
        return (
          status.message ||
          'The ChineseInLA browser profile is not authenticated.'
        );
      }

      const id = createHash('sha256')
        .update(
          `chineseinla\0${credentials.binaryPath}\0${credentials.mcpEndpoint}`
        )
        .digest('hex')
        .slice(0, 24);
      return {
        id,
        name: credentials.profileName,
        accessToken: params.code,
        refreshToken: params.code,
        expiresIn: 60 * 60 * 24 * 365 * 100,
        picture: `${
          process.env.FRONTEND_URL || ''
        }/icons/platforms/chineseinla.png`,
        username: credentials.profileName,
      };
    } catch (error) {
      return error instanceof Error
        ? error.message
        : 'ChineseInLA login check failed.';
    }
  }

  override async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    const credentials = this.decodeCredentials(refreshToken);
    return {
      id: createHash('sha256')
        .update(
          `chineseinla\0${credentials.binaryPath}\0${credentials.mcpEndpoint}`
        )
        .digest('hex')
        .slice(0, 24),
      name: credentials.profileName,
      accessToken: refreshToken,
      refreshToken,
      expiresIn: 60 * 60 * 24 * 365 * 100,
      picture: `${
        process.env.FRONTEND_URL || ''
      }/icons/platforms/chineseinla.png`,
      username: credentials.profileName,
    };
  }

  async listForums(accessToken: string) {
    const credentials = this.decodeCredentials(accessToken);
    const output = await this.callMcpTool(
      credentials,
      'chineseinla_list_forums',
      {},
      90_000
    );
    const response = this.parseJson<ChineseInLAForumResponse>(
      output,
      'forum list'
    );
    if (response.status !== 'ok' || !Array.isArray(response.forums)) {
      throw new Error('ChineseInLA did not return its forum catalog.');
    }
    return response.forums.map((forum) => this.normalizeForum(forum));
  }

  async listPosts(
    accessToken: string,
    categoryId: number,
    forumId: number,
    page = 1,
    limit = 15
  ) {
    const credentials = this.decodeCredentials(accessToken);
    const output = await this.callMcpTool(
      credentials,
      'chineseinla_list_posts',
      {
        category_id: categoryId,
        forum_id: forumId,
        page,
        limit,
      },
      90_000
    );
    const response = this.parseJson<ChineseInLAListPostsResponse>(
      output,
      'forum post list'
    );
    if (response.status !== 'ok' || !Array.isArray(response.posts)) {
      throw new Error('ChineseInLA did not return a forum post list.');
    }
    return {
      status: response.status,
      categoryId: response.category_id,
      forum: this.normalizeForum(response.forum),
      page: response.page,
      pageSize: response.page_size,
      hasNext: response.has_next,
      posts: response.posts.map((post) => ({
        topicId: post.topic_id,
        url: post.url,
        title: post.title,
        ...(post.author ? { author: post.author } : {}),
        ...(post.author_id ? { authorId: post.author_id } : {}),
        ...(post.updated_at ? { updatedAt: post.updated_at } : {}),
        replyCount: post.reply_count,
        viewCount: post.view_count,
        hasImages: post.has_images,
        highlighted: post.highlighted,
      })),
    };
  }

  async readPost(
    accessToken: string,
    categoryId: number,
    forumId: number,
    topicId: number,
    page = 1,
    limit = 10
  ) {
    const credentials = this.decodeCredentials(accessToken);
    const output = await this.callMcpTool(
      credentials,
      'chineseinla_read_post',
      {
        category_id: categoryId,
        forum_id: forumId,
        topic_id: topicId,
        page,
        limit,
      },
      90_000
    );
    const response = this.parseJson<ChineseInLAReadPostResponse>(
      output,
      'topic reader'
    );
    if (response.status !== 'ok' || !Array.isArray(response.messages)) {
      throw new Error('ChineseInLA did not return the requested topic.');
    }
    return {
      status: response.status,
      categoryId: response.category_id,
      forum: this.normalizeForum(response.forum),
      topicId: response.topic_id,
      url: response.url,
      title: response.title,
      page: response.page,
      pageSize: response.page_size,
      hasNext: response.has_next,
      messages: response.messages.map((message) => ({
        ...(message.post_id ? { postId: message.post_id } : {}),
        floor: message.floor,
        ...(message.author ? { author: message.author } : {}),
        ...(message.author_id ? { authorId: message.author_id } : {}),
        ...(message.published_at ? { publishedAt: message.published_at } : {}),
        ...(message.updated_at ? { updatedAt: message.updated_at } : {}),
        body: message.body,
        ...(message.image_urls?.length
          ? { imageUrls: message.image_urls }
          : {}),
      })),
    };
  }

  private normalizeForum(forum: ChineseInLAForumWire): ChineseInLAForum {
    const { group_id: groupId, ...normalized } = forum;
    return {
      ...normalized,
      ...(groupId ? { groupId } : {}),
    };
  }

  private tags(value?: string) {
    return (
      value
        ?.split(',')
        .map((tag) => tag.trim())
        .filter(Boolean) || []
    );
  }

  async preparePost(
    accessToken: string,
    settings: ChineseInLADto,
    value: Array<{
      content?: string;
      media?: Array<{ path?: string; type?: string }>;
    }>
  ) {
    const body = chineseInLAPostizContentToText(value[0]?.content || '');
    if (!body) {
      throw new Error('ChineseInLA requires post content.');
    }
    const forumId = Number(settings.forumId);
    if (!Number.isInteger(forumId) || forumId <= 0) {
      throw new Error('Select a valid ChineseInLA forum.');
    }
    const title = settings.title?.trim();
    if (!title) {
      throw new Error('ChineseInLA requires a title.');
    }
    if (!['question', 'classified', 'other'].includes(settings.postType)) {
      throw new Error('Select a valid ChineseInLA post type.');
    }

    const media = value.flatMap((item) => item.media || []);
    const videos = media.filter(
      (item) => item.type === 'video' || /\.mp4(?:$|\?)/i.test(item.path || '')
    );
    const images = media.filter((item) => !videos.includes(item));
    const imagePaths = await Promise.all(
      images
        .map((item) => item.path || '')
        .filter(Boolean)
        .map((path) => this.localOrPublicMediaPath(path))
    );
    const videoURLs = videos
      .map((item) => item.path || '')
      .filter((path) => /^https?:\/\//i.test(path));

    const credentials = this.decodeCredentials(accessToken);
    const result = await this.callMcpToolResult(
      credentials,
      'chineseinla_prepare_post',
      {
        forum_id: forumId,
        post_type: settings.postType,
        title,
        body,
        tags: this.tags(settings.tags),
        images: imagePaths,
        source_url: settings.sourceUrl?.trim() || '',
        video_urls: videoURLs,
        confirm_preparation: true,
      },
      5 * 60_000
    );
    const prepared = this.parseJson<ChineseInLAPrepareResponse>(
      result.text,
      'prepared post'
    );
    if (prepared.status !== 'ready_to_preview' || !prepared.draft_id) {
      throw new Error(
        prepared.message || 'ChineseInLA did not prepare a reviewable post.'
      );
    }
    const preview = this.screenshot(result);
    if (!preview) {
      throw new Error(
        'ChineseInLA did not return the required prepared-form preview. Nothing was published.'
      );
    }

    return {
      draftId: prepared.draft_id,
      preview,
      forum: this.normalizeForum(prepared.forum),
      postType: prepared.post_type,
      postTypeName: prepared.post_type_name,
      title: prepared.title,
      body,
      imageCount: prepared.image_count,
      warnings: prepared.warnings || [],
      message: prepared.message,
    };
  }

  override async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<ChineseInLADto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const draftId = postDetails[0]?.settings?.preparedDraftId?.trim();
    if (!draftId) {
      throw new Error(
        'ChineseInLA must be published immediately after reviewing its prepared-form preview. Prepare it in the Postiz composer or with chineseInLAPreparePostTool, then confirm the exact draft.'
      );
    }

    const credentials = this.decodeCredentials(accessToken);
    const output = await this.callMcpTool(
      credentials,
      'chineseinla_publish_post',
      { draft_id: draftId, confirm_publish: true },
      5 * 60_000
    );
    const published = this.parseJson<ChineseInLAPublishResponse>(
      output,
      'publish result'
    );
    if (published.status !== 'published' || !published.topic_url) {
      throw new Error(
        published.message || 'ChineseInLA did not confirm publication.'
      );
    }

    return postDetails.map((item) => ({
      id: item.id,
      postId: published.topic_url,
      releaseURL: published.topic_url,
      status: 'completed',
    }));
  }

  override async customFields() {
    return [
      {
        key: 'mcpEndpoint',
        label: 'Local MCP endpoint',
        type: 'text' as const,
        validation: '/.+/',
        defaultValue: process.env.XHS_MCP_ENDPOINT || DEFAULT_MCP_ENDPOINT,
        hint: 'ChineseInLA uses the same local MCP process as RedNote, with a separate browser profile and cookie.',
      },
      {
        key: 'profileName',
        label: 'Account label',
        type: 'text' as const,
        validation: '/.+/',
        defaultValue: 'ChineseInLA Account',
      },
    ];
  }
}
