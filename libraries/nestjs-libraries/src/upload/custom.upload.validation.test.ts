import assert from 'node:assert/strict';
import test from 'node:test';
import { CustomFileValidationPipe } from './custom.upload.validation';

const quickTimeHeader = Buffer.concat([
  Buffer.from([0, 0, 0, 20]),
  Buffer.from('ftypqt  '),
  Buffer.alloc(32),
]);

test('accepts a byte-sniffed QuickTime video and normalizes its name', async () => {
  const file = {
    buffer: quickTimeHeader,
    mimetype: 'application/octet-stream',
    fieldname: 'file',
    originalname: '../IMG_4239.MOV',
    size: quickTimeHeader.length,
  };

  const result = await new CustomFileValidationPipe().transform(file);

  assert.equal(result.mimetype, 'video/quicktime');
  assert.equal(result.originalname, '.._IMG_4239.mov');
});
