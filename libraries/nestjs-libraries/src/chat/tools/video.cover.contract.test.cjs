// Isolated contract tests: real tool/provider methods, mocked framework,
// storage and HTTP boundaries. Run with node --test and TypeScript + zod.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const nest = path.resolve(__dirname, '../..');
const decorator = () => () => {};
class SocialAbstract {
  assetBoolean(v) {
    return v === true || v === 'true';
  }
}
const hasVideoExtension = (p) =>
  /\.(mp4|mov|mpeg|mpg)$/i.test((p || '').split(/[?#]/)[0]);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const mocks = {
  '@mastra/core/tools': { createTool: (x) => x },
  '@nestjs/common': { Injectable: decorator },
  '@gitroom/nestjs-libraries/chat/auth.context': { checkAuth() {} },
  '@gitroom/nestjs-libraries/services/make.is': { makeId: () => 'test-id' },
  '@gitroom/helpers/utils/valid.url.path': {
    ValidUrlExtension: class {
      validate(p) {
        return /\.(mp4|jpg|png)$/i.test(p);
      }
      defaultMessage() {
        return 'extension';
      }
    },
    ValidUrlPath: class {
      validate() {
        return true;
      }
      defaultMessage() {
        return 'path';
      }
    },
  },
  '@gitroom/nestjs-libraries/egress/egress.relay.service': {},
  '@gitroom/nestjs-libraries/integrations/integration.manager': {
    socialIntegrationList: [],
  },
  '@gitroom/nestjs-libraries/integrations/social.abstract': {
    SocialAbstract,
    BadBody: Error,
    RefreshToken: Error,
    Disconnect: Error,
    ChannelSetupError: Error,
  },
  '@gitroom/helpers/utils/has.extension': {
    hasVideoExtension,
    hasExtension: (p, e) => p.endsWith('.' + e),
  },
  '@gitroom/nestjs-libraries/chat/rules.description.decorator': {
    Rules: decorator,
  },
  '@gitroom/helpers/decorators/post.plug': { PostPlug: decorator },
  '@gitroom/nestjs-libraries/integrations/tool.decorator': { Tool: decorator },
  '@gitroom/nestjs-libraries/integrations/social/oauth.credential.setup': {},
  '@gitroom/nestjs-libraries/upload/video.cover.image': {
    readVideoCover: async () => ({
      bytes: png,
      type: 'image/png',
      filename: 'cover.png',
    }),
  },
  '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher': {
    ssrfSafeDispatcher: {},
  },
  '@gitroom/helpers/utils/timer': {},
  '@gitroom/helpers/utils/read.or.fetch': {},
  sharp: {},
  'mime-types': {},
  'image-to-pdf': {},
  dayjs: {},
};
function load(file, overrides = {}) {
  const m = new Module(file, module);
  m.filename = file;
  m.paths = module.paths;
  m.require = (name) => {
    if (name in overrides) return overrides[name];
    if (name in mocks) return mocks[name];
    if (name.startsWith('./'))
      return load(path.resolve(path.dirname(file), name + '.ts'), overrides);
    // Real helper: the cover reader resolves first-party upload URLs to disk.
    if (name === '@gitroom/nestjs-libraries/upload/local.upload.path')
      return load(path.join(nest, 'upload/local.upload.path.ts'), overrides);
    if (
      name.includes('/dtos/posts/') ||
      name.includes('/database/prisma/') ||
      name.endsWith('/chineseinla.provider') ||
      name.endsWith('/rednote.provider')
    )
      return {};
    return require(name);
  };
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  assert.equal(
    result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error)
      .length,
    0
  );
  m._compile(result.outputText, file);
  return m.exports;
}
test('post readback exposes persisted cover metadata including zero offset', () => {
  const day = () => ({ utc: () => ({ format: () => '2026-09-18T00:00:00' }) });
  day.extend = () => {};
  const { postListItem } = load(path.join(__dirname, 'posts.list.tool.ts'), {
    dayjs: day,
    'dayjs/plugin/utc': {},
    '@gitroom/nestjs-libraries/database/prisma/posts/post.error.message': {
      postErrorMessage: () => null,
    },
  });
  const media = [{ path: 'https://uploads.example/v.mp4', thumbnailTimestamp: 0 }];
  assert.deepEqual(postListItem({ image: JSON.stringify(media) }).media, [
    { ...media[0], thumbnail: undefined },
  ]);
  assert.deepEqual(postListItem({ image: 'broken' }).media, []);
});
const video = 'https://uploads.example/video.mp4',
  cover = 'https://uploads.example/cover.png';
const post = (provider) => ({
  integrationId: provider,
  isPremium: false,
  date: '2026-09-18T20:00:00Z',
  shortLink: false,
  type: 'draft',
  settings: [],
  postsAndComments: [
    { content: 'Video', attachments: [{ path: video, thumbnail: cover }] },
  ],
});

test('MCP preserves cover through schema, validation and persistence; maps YouTube', async () => {
  const { IntegrationSchedulePostTool } = load(
    path.join(__dirname, 'integration.schedule.post.ts')
  );
  const created = [],
    validated = [];
  const tool = new IntegrationSchedulePostTool(
    {
      validatePosts: async (_, p) => {
        validated.push(p);
        return [{ emptyContent: false, valid: true, errors: true }];
      },
      createPost: async (_, p) => {
        created.push(p);
        return [{ postId: 'one', integration: 'test' }];
      },
    },
    { getIntegrationById: async (_, id) => ({ providerIdentifier: id }) },
    {}
  ).run();
  const input = tool.inputSchema.parse({
    socialPost: [post('linkedin'), post('youtube')],
  });
  await tool.execute(input, {
    requestContext: new Map([['organization', '{"id":"org"}']]),
  });
  assert.equal(validated[0][0].value[0].image[0].thumbnail, cover);
  assert.equal(created[0].posts[0].value[0].image[0].thumbnail, cover);
  assert.equal(created[1].posts[0].settings.thumbnail.path, cover);
  assert.throws(() =>
    tool.inputSchema.parse({
      socialPost: [
        {
          ...post('linkedin'),
          postsAndComments: [
            {
              content: '',
              attachments: [{ path: video, thumbnail: 'http://bad/cover.png' }],
            },
          ],
        },
      ],
    })
  );
});
test('MCP validates entire batch before creating anything', async () => {
  const { IntegrationSchedulePostTool } = load(
    path.join(__dirname, 'integration.schedule.post.ts')
  );
  let creates = 0;
  const tool = new IntegrationSchedulePostTool(
    {
      validatePosts: async () => [
        { emptyContent: false, valid: true, errors: true },
      ],
      createPost: async () => {
        creates++;
        return [];
      },
    },
    { getIntegrationById: async (_, id) => ({ providerIdentifier: id }) },
    {}
  ).run();
  const result = await tool.execute(
    tool.inputSchema.parse({ socialPost: [post('linkedin'), post('x')] }),
    { requestContext: new Map([['organization', '{"id":"org"}']]) }
  );
  assert.match(result.output.errors, /not supported/);
  assert.equal(creates, 0);
});
test('LinkedIn requests thumbnail upload, uploads bytes before finalize; legacy no-cover unchanged', async () => {
  const { LinkedinProvider } = load(
    path.join(nest, 'integrations/social/linkedin.provider.ts')
  );
  for (const withCover of [false, true]) {
    const p = new LinkedinProvider(),
      calls = [];
    p.fetch = async (url, init) => {
      calls.push({ url, init });
      return {
        json: async () => ({
          value: {
            video: 'urn:video:1',
            thumbnailUploadUrl: 'https://linkedin.example/thumb',
            uploadInstructions: [
              { uploadUrl: 'https://linkedin.example/video' },
            ],
          },
        }),
        headers: new Headers({ etag: 'part1' }),
      };
    };
    await p.uploadPicture(
      video,
      'token',
      'person',
      Buffer.from('video'),
      'personal',
      withCover ? cover : undefined
    );
    assert.equal(
      JSON.parse(calls[0].init.body).initializeUploadRequest.uploadThumbnail,
      withCover
    );
    const upload = calls.find((c) => c.url.endsWith('/thumb'));
    assert.equal(!!upload, withCover);
    if (upload) {
      assert.deepEqual(upload.init.body, png);
      assert.equal(upload.init.headers['media-type-family'], 'STILLIMAGE');
      assert.equal(upload.init.headers.Authorization, undefined);
    }
    assert.match(calls.at(-1).url, /finalizeUpload/);
  }
});
test('LinkedIn missing thumbnail URL fails before post creation', async () => {
  const { LinkedinProvider } = load(
    path.join(nest, 'integrations/social/linkedin.provider.ts')
  );
  const p = new LinkedinProvider();
  let calls = 0;
  p.fetch = async () => {
    calls++;
    return {
      json: async () => ({
        value: { video: 'v', uploadInstructions: [{ uploadUrl: 'u' }] },
      }),
    };
  };
  await assert.rejects(
    p.uploadPicture(
      video,
      'token',
      'person',
      Buffer.from('video'),
      'personal',
      cover
    ),
    /thumbnail upload URL/
  );
  assert.equal(calls, 1);
});
test('Facebook sends thumb as multipart FILE, not URL or separate post', async () => {
  const { FacebookProvider } = load(
    path.join(nest, 'integrations/social/facebook.provider.ts')
  );
  const p = new FacebookProvider();
  let request;
  p.fetch = async (url, init) => {
    request = init;
    return { json: async () => ({ id: 'video1' }) };
  };
  await p.postNonStory('page', 'token', [
    {
      id: 'p',
      media: [{ path: video, thumbnail: cover }],
      message: 'Caption',
      settings: {},
    },
  ]);
  assert.ok(request.body instanceof FormData);
  assert.equal(request.body.get('file_url'), video);
  assert.equal(request.body.get('thumb').type, 'image/png');
  assert.equal(request.headers['Content-Type'], undefined);
});
test('TikTok frame offset lives in post_info including zero', () => {
  const { TiktokProvider } = load(
    path.join(nest, 'integrations/social/tiktok.provider.ts')
  );
  const p = new TiktokProvider();
  for (const offset of [0, 1250])
    assert.equal(
      p.buildTikokPostInfoBody({
        media: [{ path: video, thumbnailTimestamp: offset }],
        message: 'Caption',
        settings: {},
      }).post_info.video_cover_timestamp_ms,
      offset
    );
});
test('Instagram sends cover_url instead of thumb_offset on both login routes', async () => {
  const { InstagramProvider } = load(
    path.join(nest, 'integrations/social/instagram.provider.ts'),
    {
      '@gitroom/nestjs-libraries/integrations/social/facebook.provider': {
        facebookApiVersion: () => 'v26.0',
      },
    }
  );
  for (const host of ['graph.facebook.com', 'graph.instagram.com']) {
    for (const media of [
      { path: video, thumbnail: cover },
      { path: video, thumbnailTimestamp: 0 },
    ]) {
      const p = new InstagramProvider();
      let request;
      p.fetch = async (url) => {
        request = new URL(url);
        return { json: async () => ({ id: 'container' }) };
      };
      await p.postPending(
        'account',
        'token',
        [
          {
            id: 'p',
            media: [media],
            message: 'caption',
            settings: { post_type: 'post' },
          },
        ],
        {},
        host
      );
      assert.equal(request.hostname, host);
      assert.equal(request.searchParams.get('media_type'), 'REELS');
      if (media.thumbnail) {
        assert.equal(request.searchParams.get('cover_url'), cover);
        assert.equal(request.searchParams.has('thumb_offset'), false);
      } else assert.equal(request.searchParams.get('thumb_offset'), '0');
    }
  }
});
test('cover download rejects bad schemes, HTML and oversized files; no credentials forwarded', async () => {
  const { readVideoCover } = load(
    path.join(nest, 'upload/video.cover.image.ts')
  );
  const original = global.fetch;
  try {
    await assert.rejects(readVideoCover('file:///tmp/a.png'), /HTTPS/);
    global.fetch = async (_, opts) => {
      assert.equal(opts.headers, undefined);
      assert.equal(opts.redirect, 'error');
      return new Response(png);
    };
    assert.equal((await readVideoCover(cover)).type, 'image/png');
    global.fetch = async () => new Response('<html>error</html>');
    await assert.rejects(readVideoCover(cover), /JPEG or PNG/);
    global.fetch = async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1));
    await assert.rejects(readVideoCover(cover), /2 MiB/);
  } finally {
    global.fetch = original;
  }
});
