import { readFileSync, statSync } from 'fs';
import { ssrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import {
  isLocalUploadPath,
  resolveLocalUploadPath,
} from '@gitroom/nestjs-libraries/upload/local.upload.path';

const MAX_COVER_BYTES = 2 * 1024 * 1024;

// Covers are small image files. Never forward a provider token to the source,
// follow redirects to private hosts, or buffer an unbounded response.
export async function readVideoCover(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('Cover requires a public HTTPS upload URL.');

  // A cover uploaded to this instance is read from disk like every other
  // first-party media: the public hostname may resolve to a private address
  // inside the deployment, which the SSRF-safe fetch below rightly refuses.
  const local = resolveLocalUploadPath(url);
  const bytes = isLocalUploadPath(url, local)
    ? readLocalCover(local)
    : await fetchCover(url);
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg)
    throw new Error('Cover must contain JPEG or PNG image data.');
  return {
    bytes,
    type: png ? 'image/png' : 'image/jpeg',
    filename: png ? 'cover.png' : 'cover.jpg',
  };
}

function readLocalCover(path: string) {
  if (statSync(path).size > MAX_COVER_BYTES)
    throw new Error('Cover image must be at most 2 MiB.');
  return readFileSync(path);
}

async function fetchCover(url: string) {
  const response = await fetch(url, {
    // @ts-ignore undici dispatcher is not in lib.dom
    dispatcher: ssrfSafeDispatcher,
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Cover download failed (${response.status}).`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_COVER_BYTES)
        throw new Error('Cover image must be at most 2 MiB.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
