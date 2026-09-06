import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveLocalUploadPath,
  serveLocalUpload,
} from './local-upload-route.js';

test('serves an uploaded image with provider-safe headers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'postiz-upload-'));
  await mkdir(path.join(directory, '2026', '09', '06'), { recursive: true });
  await writeFile(
    path.join(directory, '2026', '09', '06', 'photo.jpg'),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  );

  const response = await serveLocalUpload(
    directory,
    ['2026', '09', '06', 'photo.jpg'],
    'GET'
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('content-length'), '4');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  );
});

test('supports HEAD without streaming the file body', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'postiz-upload-'));
  await writeFile(path.join(directory, 'clip.mp4'), Buffer.from('video'));

  const response = await serveLocalUpload(directory, ['clip.mp4'], 'HEAD');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('content-length'), '5');
  assert.equal(await response.text(), '');
});

test('rejects traversal and missing files with a 404', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'postiz-upload-'));

  assert.equal(
    resolveLocalUploadPath(directory, ['..', 'secret.txt']),
    undefined
  );
  assert.equal(
    (await serveLocalUpload(directory, ['missing.jpg'])).status,
    404
  );
});
