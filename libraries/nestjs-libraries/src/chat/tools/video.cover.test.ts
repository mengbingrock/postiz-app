import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareVideoCovers, videoCoverRules } from './video.cover';
const path = 'https://uploads.example/video.mp4';
const thumbnail = 'https://uploads.example/cover.jpg';
const post = (attachment: any) => [
  { content: 'Caption', attachments: [attachment] },
];

test('legacy string media remains unchanged', () => {
  assert.deepEqual(
    prepareVideoCovers('linkedin', post(path), {}).value[0].image,
    [{ path }]
  );
});
for (const provider of [
  'linkedin',
  'linkedin-page',
  'linkedin-byo',
  'linkedin-page-byo',
  'facebook',
  'instagram',
  'instagram-standalone',
  'tiktok-business',
  'reddit',
]) {
  test(`${provider}: binds one cover to one video`, () => {
    const input = post({ path, thumbnail });
    assert.deepEqual(prepareVideoCovers(provider, input, {}).value[0].image, [
      { path, thumbnail },
    ]);
    assert.equal(input[0].attachments.length, 1);
  });
}
test('YouTube maps cover into provider settings and preserves settings', () => {
  const settings = { title: 'Video', type: 'private' };
  const result = prepareVideoCovers(
    'youtube',
    post({ path, thumbnail }),
    settings
  );
  assert.equal(result.settings.thumbnail.path, thumbnail);
  assert.equal(result.settings.title, 'Video');
  assert.equal((settings as any).thumbnail, undefined);
  assert.throws(
    () =>
      prepareVideoCovers('youtube', post({ path, thumbnail }), {
        thumbnail: { path: 'different' },
      }),
    /Conflicting/
  );
});
test('Pinterest adapts its provider-specific second image without changing input', () => {
  const input = post({ path, thumbnail });
  assert.equal(
    prepareVideoCovers('pinterest', input, {}).value[0].image[1].path,
    thumbnail
  );
  assert.equal(input[0].attachments.length, 1);
});
for (const provider of [
  'instagram',
  'instagram-standalone',
  'tiktok',
  'tiktok-business',
]) {
  test(`${provider}: preserves zero frame offset`, () => {
    assert.equal(
      prepareVideoCovers(provider, post({ path, thumbnailTimestamp: 0 }), {})
        .value[0].image[0].thumbnailTimestamp,
      0
    );
  });
}
test('does not silently discard incompatible cover requests', () => {
  for (const provider of [
    'x',
    'threads',
    'bluesky',
    'telegram',
    'gmb',
    'unknown',
    'tiktok',
  ]) {
    assert.throws(
      () => prepareVideoCovers(provider, post({ path, thumbnail }), {}),
      /not supported/
    );
  }
  assert.throws(
    () =>
      prepareVideoCovers('facebook', post({ path, thumbnail }), {
        post_type: 'story',
      }),
    /Stories/
  );
  assert.throws(
    () =>
      prepareVideoCovers('linkedin', post({ path, thumbnailTimestamp: 2 }), {}),
    /not supported/
  );
  assert.throws(
    () =>
      prepareVideoCovers('tiktok', post({ path, thumbnailTimestamp: 0 }), {
        content_posting_method: 'UPLOAD',
      }),
    /inbox/
  );
});
test('rejects ambiguity and invalid offsets before publishing', () => {
  assert.throws(
    () =>
      prepareVideoCovers(
        'instagram',
        post({ path, thumbnail, thumbnailTimestamp: 0 }),
        {}
      ),
    /not both/
  );
  assert.throws(
    () =>
      prepareVideoCovers('instagram', post({ path: thumbnail, thumbnail }), {}),
    /requires a video/
  );
  for (const thumbnailTimestamp of [-1, 0.5, NaN, Infinity, 2147483648]) {
    assert.throws(
      () =>
        prepareVideoCovers('instagram', post({ path, thumbnailTimestamp }), {}),
      /int32/
    );
  }
  assert.throws(
    () =>
      prepareVideoCovers(
        'instagram',
        [{ content: '', attachments: [{ path, thumbnail }, path] }],
        {}
      ),
    /carousel/
  );
  assert.throws(
    () =>
      prepareVideoCovers(
        'facebook',
        [...post(path), ...post({ path, thumbnail })],
        {}
      ),
    /comments/
  );
});
test('discovery distinguishes image versus frame support', () => {
  assert.match(
    videoCoverRules('linkedin'),
    /separate image supported; frame timestamp not supported/
  );
  assert.match(
    videoCoverRules('tiktok'),
    /separate image not supported.*frame timestamp supported/
  );
});
