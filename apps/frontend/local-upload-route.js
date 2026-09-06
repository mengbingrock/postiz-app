import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import mime from 'mime';

const notFound = () => new Response('Not found', { status: 404 });

export function resolveLocalUploadPath(uploadDirectory, path = []) {
  if (!uploadDirectory) {
    throw new Error('UPLOAD_DIRECTORY is not configured');
  }

  const base = resolve(uploadDirectory);
  const filePath = resolve(base, path.join('/'));
  if (filePath === base || !filePath.startsWith(base + sep)) {
    return undefined;
  }

  return filePath;
}

export async function serveLocalUpload(
  uploadDirectory,
  path = [],
  method = 'GET'
) {
  const filePath = resolveLocalUploadPath(uploadDirectory, path);
  if (!filePath) return notFound();

  let fileStats;
  try {
    fileStats = await stat(/* turbopackIgnore: true */ filePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return notFound();
    }
    throw error;
  }

  if (!fileStats.isFile()) return notFound();

  const headers = {
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Length': fileStats.size.toString(),
    'Content-Security-Policy':
      "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'none'; script-src 'none'; frame-ancestors 'none'; sandbox",
    'Content-Type': mime.getType(filePath) || 'application/octet-stream',
    'Last-Modified': fileStats.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  };

  if (method === 'HEAD') {
    return new Response(null, { headers });
  }

  const response = createReadStream(/* turbopackIgnore: true */ filePath);
  const iterator = response[Symbol.asyncIterator]();
  const stream = new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(new Uint8Array(value));
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });

  return new Response(stream, { headers });
}
