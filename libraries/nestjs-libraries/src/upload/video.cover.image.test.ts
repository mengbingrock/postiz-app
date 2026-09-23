import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVideoCover } from './video.cover.image';

const JPEG = Buffer.concat([
  Buffer.from([255, 216, 255, 224]),
  Buffer.from('postiz-cover'),
]);

const withInstance = async (
  run: (directory: string, cleanup: () => Promise<void>) => Promise<void>
) => {
  const directory = await mkdtemp(join(tmpdir(), 'postiz-cover-'));
  const previousFrontendUrl = process.env.FRONTEND_URL;
  const previousUploadDirectory = process.env.UPLOAD_DIRECTORY;
  const previousFetch = globalThis.fetch;
  process.env.FRONTEND_URL = 'https://post.example.test';
  process.env.UPLOAD_DIRECTORY = directory;
  try {
    await run(directory, async () => undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontendUrl;
    if (previousUploadDirectory === undefined)
      delete process.env.UPLOAD_DIRECTORY;
    else process.env.UPLOAD_DIRECTORY = previousUploadDirectory;
    await rm(directory, { recursive: true, force: true });
  }
};

test('a cover uploaded to this instance is read from disk, never fetched', async () => {
  await withInstance(async (directory) => {
    const nested = join(directory, '2026', '09', '21');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'cover.jpg'), JPEG);
    globalThis.fetch = (async () => {
      throw new Error('fetch failed: Blocked IP');
    }) as typeof fetch;

    const cover = await readVideoCover(
      'https://post.example.test/uploads/2026/09/21/cover.jpg'
    );
    assert.equal(cover.type, 'image/jpeg');
    assert.equal(cover.filename, 'cover.jpg');
    assert.equal(cover.bytes.equals(JPEG), true);
  });
});

test('a foreign cover URL still goes through the guarded fetch', async () => {
  await withInstance(async () => {
    let fetched = '';
    globalThis.fetch = (async (input: string | URL) => {
      fetched = String(input);
      return new Response(JPEG, { status: 200 });
    }) as typeof fetch;

    const cover = await readVideoCover('https://cdn.example.org/cover.jpg');
    assert.equal(fetched, 'https://cdn.example.org/cover.jpg');
    assert.equal(cover.type, 'image/jpeg');
  });
});

test('a first-party URL whose file is missing falls back to the guarded fetch', async () => {
  await withInstance(async () => {
    globalThis.fetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;
    await assert.rejects(
      () =>
        readVideoCover('https://post.example.test/uploads/2026/09/21/nope.jpg'),
      /fetch failed/
    );
  });
});
