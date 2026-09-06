import assert from 'node:assert/strict';
import test from 'node:test';
import { hasVideoExtension } from './has.extension';

test('recognizes supported media-library video extensions', () => {
  for (const path of [
    'https://example.com/video.mp4',
    'https://example.com/IMG_4239.MOV',
    'https://example.com/video.mpeg?download=1',
    'https://example.com/video.mpg#preview',
  ]) {
    assert.equal(hasVideoExtension(path), true, path);
  }
});

test('does not classify images or missing paths as videos', () => {
  for (const path of [
    'https://example.com/image.png',
    'https://example.com/movement.jpg',
    'https://example.com/video.mov.jpg',
    '',
    null,
    undefined,
  ]) {
    assert.equal(hasVideoExtension(path), false, String(path));
  }
});
