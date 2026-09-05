import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBase64Image } from './upload.media.input';

const onePixelPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('decodeBase64Image accepts raw base64 image data', () => {
  const output = decodeBase64Image(onePixelPng);

  assert.equal(output.subarray(1, 4).toString(), 'PNG');
});

test('decodeBase64Image accepts a base64 data URL', () => {
  const output = decodeBase64Image(`data:image/png;base64,${onePixelPng}`);

  assert.equal(output.subarray(1, 4).toString(), 'PNG');
});

test('decodeBase64Image rejects malformed base64', () => {
  assert.throws(
    () => decodeBase64Image('this is not base64!'),
    /valid base64/i
  );
});
