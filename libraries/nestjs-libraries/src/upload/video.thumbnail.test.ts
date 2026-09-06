import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ffmpegStatic from 'ffmpeg-static';
import { createVideoThumbnail } from './video.thumbnail';

test('extracts a JPEG poster frame from a MOV video', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postiz-thumbnail-test-'));
  const input = join(directory, 'fixture.mov');

  try {
    execFileSync(ffmpegStatic || 'ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x48:d=1',
      '-c:v',
      'mpeg4',
      '-y',
      input,
    ]);

    const thumbnail = await createVideoThumbnail(
      readFileSync(input),
      'video/quicktime'
    );

    assert.ok(thumbnail);
    assert.deepEqual([...thumbnail.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('does not run thumbnail extraction for images', async () => {
  assert.equal(
    await createVideoThumbnail(Buffer.from('not an image'), 'image/jpeg'),
    undefined
  );
});
