import { ssrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';

// Covers are small image files. Never forward a provider token to the source,
// follow redirects to private hosts, or buffer an unbounded response.
export async function readVideoCover(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('Cover requires a public HTTPS upload URL.');
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
      if (size > 2 * 1024 * 1024)
        throw new Error('Cover image must be at most 2 MiB.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
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
