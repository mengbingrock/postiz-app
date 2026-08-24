import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  BadBody,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { TajimaWebsiteDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/tajima.website.dto';
import { Integration } from '@prisma/client';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import dayjs from 'dayjs';
import slugify from 'slugify';

type TajimaGithubCredentials = {
  token: string;
  owner: string;
  repository: string;
  branch: string;
  siteUrl: string;
};

type GithubContent = {
  content?: string;
  sha?: string;
};

const githubApi = 'https://api.github.com';

const githubHeaders = (token: string) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'User-Agent': 'Postiz-Tajima-Website',
  'X-GitHub-Api-Version': '2022-11-28',
});

const cleanCredentials = (
  credentials: TajimaGithubCredentials
): TajimaGithubCredentials => ({
  token: credentials.token.trim(),
  owner: credentials.owner.trim(),
  repository: credentials.repository.trim(),
  branch: credentials.branch.trim(),
  siteUrl: credentials.siteUrl.trim().replace(/\/+$/, ''),
});

const repositoryUrl = (credentials: TajimaGithubCredentials, path = '') =>
  `${githubApi}/repos/${encodeURIComponent(
    credentials.owner
  )}/${encodeURIComponent(credentials.repository)}${path}`;

const articleUrl = (credentials: TajimaGithubCredentials, slug: string) =>
  `${credentials.siteUrl}/blog/${slug}.html`;

const categoriesFrom = (value: string) =>
  value
    .split(',')
    .map((category) => category.trim())
    .filter(Boolean)
    .slice(0, 6);

const imageExtension = (contentType: string) => {
  const types: Record<string, string> = {
    'image/avif': 'avif',
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  return types[contentType.split(';')[0].trim().toLowerCase()];
};

export class TajimaWebsiteProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'tajima-website';
  name = 'Tajima LLP Website';
  isBetweenSteps = false;
  editor = 'markdown' as const;
  scopes = [] as string[];
  dto = TajimaWebsiteDto;
  override maxConcurrentJob = 1;

  maxLength() {
    return 100000;
  }

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  async customFields() {
    return [
      {
        key: 'token',
        label: 'GitHub fine-grained token',
        validation: '/^.{20,}$/',
        type: 'password' as const,
        hint: 'Grant Contents read/write access to the Tajima website repository.',
      },
      {
        key: 'owner',
        label: 'GitHub owner',
        defaultValue: 'mengbingrock',
        validation: '/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/',
        type: 'text' as const,
      },
      {
        key: 'repository',
        label: 'GitHub repository',
        defaultValue: 'tajima-site',
        validation: '/^[A-Za-z0-9._-]+$/',
        type: 'text' as const,
      },
      {
        key: 'branch',
        label: 'Publishing branch',
        defaultValue: 'main',
        validation: '/^[A-Za-z0-9._/-]+$/',
        type: 'text' as const,
      },
      {
        key: 'siteUrl',
        label: 'Public website URL',
        defaultValue: 'https://tajima-site-dev-menbinwan.netlify.app',
        validation: '/^https://[^\\s/$.?#].[^\\s]*$/',
        type: 'text' as const,
      },
    ];
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    let credentials: TajimaGithubCredentials;
    try {
      credentials = cleanCredentials(
        JSON.parse(Buffer.from(params.code, 'base64').toString())
      );
    } catch {
      return 'The website channel settings are invalid.';
    }

    try {
      const [repositoryResponse, branchResponse] = await Promise.all([
        fetch(repositoryUrl(credentials), {
          headers: githubHeaders(credentials.token),
        }),
        fetch(
          repositoryUrl(
            credentials,
            `/branches/${encodeURIComponent(credentials.branch)}`
          ),
          { headers: githubHeaders(credentials.token) }
        ),
      ]);

      if (!repositoryResponse.ok) {
        return repositoryResponse.status === 401
          ? 'GitHub rejected the token. Create a fine-grained token with access to the Tajima website repository.'
          : `GitHub could not access ${credentials.owner}/${credentials.repository} (HTTP ${repositoryResponse.status}).`;
      }
      if (!branchResponse.ok) {
        return `GitHub could not access branch ${credentials.branch} (HTTP ${branchResponse.status}).`;
      }

      const repository = await repositoryResponse.json();
      if (repository.permissions && repository.permissions.push !== true) {
        return 'The GitHub token can read the repository but cannot publish to it. Grant Contents read/write access.';
      }

      return {
        refreshToken: '',
        expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
        accessToken: Buffer.from(JSON.stringify(credentials)).toString(
          'base64'
        ),
        id: `github:${credentials.owner}/${credentials.repository}:${credentials.branch}`,
        name: 'Tajima LLP Website',
        picture: `${credentials.siteUrl}/favicon-32x32.png`,
        username: `${credentials.owner}/${credentials.repository}`,
      };
    } catch {
      return 'Could not reach GitHub. Check the repository settings and try again.';
    }
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  override handleErrors(body: string, status: number) {
    if (status === 401 || status === 403) {
      return {
        type: 'bad-body' as const,
        value:
          'GitHub rejected the website token. Reconnect the channel with a token that has Contents read/write access.',
      };
    }
    if (status === 409) {
      return {
        type: 'retry' as const,
        value: 'The website repository changed while publishing. Retrying.',
      };
    }
    if (status === 422) {
      return {
        type: 'bad-body' as const,
        value:
          'GitHub rejected the article commit. The slug may already be in use.',
      };
    }
    return undefined;
  }

  private async existingContent(
    credentials: TajimaGithubCredentials,
    path: string
  ): Promise<GithubContent | null> {
    const response = await fetch(
      repositoryUrl(
        credentials,
        `/contents/${path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}?ref=${encodeURIComponent(credentials.branch)}`
      ),
      { headers: githubHeaders(credentials.token) }
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new BadBody(
        this.identifier,
        await response.text().catch(() => '{}'),
        '{}',
        `Could not inspect ${path} in the website repository.`
      );
    }
    return response.json();
  }

  private async putContent(
    credentials: TajimaGithubCredentials,
    path: string,
    message: string,
    content: Buffer,
    existingSha?: string
  ) {
    return (
      await this.fetch(
        repositoryUrl(
          credentials,
          `/contents/${path.split('/').map(encodeURIComponent).join('/')}`
        ),
        {
          method: 'PUT',
          headers: githubHeaders(credentials.token),
          body: JSON.stringify({
            message,
            content: content.toString('base64'),
            branch: credentials.branch,
            ...(existingSha ? { sha: existingSha } : {}),
          }),
        },
        this.identifier
      )
    ).json();
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<TajimaWebsiteDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const credentials = cleanCredentials(
      JSON.parse(Buffer.from(accessToken, 'base64').toString())
    );
    const post = postDetails[0];
    const settings = post.settings;
    const slug =
      settings.slug ||
      slugify(settings.title, { lower: true, strict: true, trim: true });
    const categories = categoriesFrom(settings.categories);
    if (!slug) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'The article title could not produce a URL slug. Enter a custom slug.'
      );
    }
    if (post.message.trim().length < 300) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'A Tajima LLP website article must contain at least 300 characters.'
      );
    }
    if (!categories.length) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'Enter at least one article category.'
      );
    }
    const contentPath = `content/postiz/${slug}.json`;
    const publicUrl = articleUrl(credentials, slug);
    const existingArticle = await this.existingContent(
      credentials,
      contentPath
    );

    if (existingArticle?.content) {
      try {
        const existing = JSON.parse(
          Buffer.from(
            existingArticle.content.replace(/\s/g, ''),
            'base64'
          ).toString()
        );
        if (existing.postizPostId === post.id) {
          return [
            {
              id: post.id,
              status: 'completed',
              postId: existing.commitSha || existingArticle.sha || post.id,
              releaseURL: publicUrl,
            },
          ];
        }
      } catch {
        // A malformed or non-Postiz file still owns the slug; report the
        // collision below rather than overwriting repository content.
      }
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        `The website slug "${slug}" is already in use. Choose another slug.`
      );
    }

    let heroImage:
      | {
          path: string;
          alt: string;
        }
      | undefined;

    if (settings.main_image?.path) {
      const mediaUrl = settings.main_image.path.startsWith('http')
        ? settings.main_image.path
        : `${process.env.FRONTEND_URL?.replace(
            /\/+$/,
            ''
          )}/${settings.main_image.path.replace(/^\/+/, '')}`;
      const imageResponse = await this.fetch(mediaUrl, {}, this.identifier);
      const contentType = imageResponse.headers.get('content-type') || '';
      const extension = imageExtension(contentType);
      if (!extension) {
        throw new BadBody(
          this.identifier,
          '{}',
          '{}',
          'The website cover must be a PNG, JPEG, WebP, GIF, or AVIF image.'
        );
      }
      const image = Buffer.from(await imageResponse.arrayBuffer());
      if (image.length > 10 * 1024 * 1024) {
        throw new BadBody(
          this.identifier,
          '{}',
          '{}',
          'The website cover image must be 10 MB or smaller.'
        );
      }
      const imagePath = `images/postiz/${slug}.${extension}`;
      const existingImage = await this.existingContent(credentials, imagePath);
      await this.putContent(
        credentials,
        imagePath,
        `Add cover image for ${settings.title}`,
        image,
        existingImage?.sha
      );
      heroImage = {
        path: `/${imagePath}`,
        alt: settings.main_image.alt || `${settings.title} — Tajima LLP`,
      };
    }

    const publishedAt = new Date().toISOString();
    const article = {
      schemaVersion: 1,
      source: 'postiz',
      postizPostId: post.id,
      siteUrl: credentials.siteUrl,
      title: settings.title.trim(),
      slug,
      description: settings.description.trim(),
      author: settings.author,
      categories,
      publishedAt,
      modifiedAt: publishedAt,
      heroImage,
      bodyMarkdown: post.message.trim(),
    };
    const result = await this.putContent(
      credentials,
      contentPath,
      `Publish article: ${settings.title}`,
      Buffer.from(`${JSON.stringify(article, null, 2)}\n`)
    );

    return [
      {
        id: post.id,
        status: 'completed',
        postId: result.commit?.sha || result.content?.sha || post.id,
        releaseURL: publicUrl,
      },
    ];
  }
}
