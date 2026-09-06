import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialAbstract } from './social.abstract';

class TestSocialProvider extends SocialAbstract {
  identifier = 'test';

  resolveMedia(path: string) {
    return this.localPostizMediaPath(path);
  }

  size(path: string) {
    return this.mediaSize(path, this.identifier);
  }

  chunk(path: string, start: number, end: number) {
    return this.mediaChunk(path, start, end, this.identifier);
  }
}

test('first-party local upload URLs are read from disk without an SSRF-network fetch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'postiz-local-media-'));
  const nested = join(directory, '2026', '09', '06');
  const file = join(nested, 'video.mov');
  const previousFrontendUrl = process.env.FRONTEND_URL;
  const previousUploadDirectory = process.env.UPLOAD_DIRECTORY;

  try {
    await mkdir(nested, { recursive: true });
    await writeFile(file, Buffer.from('local-video'));
    process.env.FRONTEND_URL = 'https://post.example.test';
    process.env.UPLOAD_DIRECTORY = directory;

    const provider = new TestSocialProvider();
    const url =
      'https://post.example.test/uploads/2026/09/06/video.mov?signature=ok';

    assert.equal(provider.resolveMedia(url), file);
    assert.equal(await provider.size(url), 11);
    assert.deepEqual(await provider.chunk(url, 0, 4), Buffer.from('local'));
  } finally {
    if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontendUrl;
    if (previousUploadDirectory === undefined) {
      delete process.env.UPLOAD_DIRECTORY;
    } else {
      process.env.UPLOAD_DIRECTORY = previousUploadDirectory;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('untrusted and path-traversing media URLs remain remote URLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'postiz-local-media-'));
  const previousFrontendUrl = process.env.FRONTEND_URL;
  const previousUploadDirectory = process.env.UPLOAD_DIRECTORY;

  try {
    process.env.FRONTEND_URL = 'https://post.example.test';
    process.env.UPLOAD_DIRECTORY = directory;
    const provider = new TestSocialProvider();
    const external = 'https://media.example.test/uploads/video.mov';
    const traversal =
      'https://post.example.test/uploads/%2e%2e/%2e%2e/etc/passwd';

    assert.equal(provider.resolveMedia(external), external);
    assert.equal(provider.resolveMedia(traversal), traversal);
  } finally {
    if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontendUrl;
    if (previousUploadDirectory === undefined) {
      delete process.env.UPLOAD_DIRECTORY;
    } else {
      process.env.UPLOAD_DIRECTORY = previousUploadDirectory;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
