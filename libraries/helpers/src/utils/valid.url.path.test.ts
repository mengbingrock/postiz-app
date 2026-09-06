import assert from 'node:assert/strict';
import test from 'node:test';
import { ValidUrlExtension } from './valid.url.path';

const validator = new ValidUrlExtension();

test('accepts supported image and video URL extensions', () => {
  for (const path of [
    'https://example.com/image.webp',
    'https://example.com/video.mp4',
    'https://example.com/IMG_4239.MOV?download=1',
    'https://example.com/video.mpeg#preview',
    'https://example.com/video.mpg',
  ]) {
    assert.equal(validator.validate(path, {} as any), true, path);
  }
});

test('rejects unsupported or misleading extensions', () => {
  for (const path of [
    'https://example.com/video.mov.jpg.exe',
    'https://example.com/video',
    '',
  ]) {
    assert.equal(validator.validate(path, {} as any), false, path);
  }
});
