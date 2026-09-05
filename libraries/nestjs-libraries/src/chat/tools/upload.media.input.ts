import { getMaxSize } from '@gitroom/nestjs-libraries/upload/custom.upload.validation';

export const MAX_IMAGE_SIZE = getMaxSize('image/png');
export const MAX_ENCODED_IMAGE_SIZE = Math.ceil(MAX_IMAGE_SIZE / 3) * 4 + 256;

export const decodeBase64Image = (input: string): Buffer => {
  const trimmed = input.trim();
  const dataUrl = /^data:[^;,]+;base64,([\s\S]*)$/i.exec(trimmed);
  const encoded = (dataUrl?.[1] ?? trimmed).replace(/\s/g, '');

  if (
    !encoded ||
    encoded.length > MAX_ENCODED_IMAGE_SIZE ||
    encoded.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new Error('Image data must be valid base64 or a base64 data URL.');
  }

  const buffer = Buffer.from(encoded, 'base64');
  const canonicalInput = encoded.replace(/=+$/, '');
  const canonicalDecoded = buffer.toString('base64').replace(/=+$/, '');
  if (canonicalInput !== canonicalDecoded) {
    throw new Error('Image data must be valid base64 or a base64 data URL.');
  }

  if (buffer.length > MAX_IMAGE_SIZE) {
    throw new Error(
      `Image is too large: ${buffer.length} bytes (max ${MAX_IMAGE_SIZE} bytes).`
    );
  }

  return buffer;
};
