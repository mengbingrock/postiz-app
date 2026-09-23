import { statSync } from 'fs';
import { resolve, sep } from 'path';

/**
 * Resolve media served by this Postiz instance's own `/uploads/` route to its
 * file on disk. Besides saving a network round trip, this keeps first-party
 * media working when the public hostname resolves to a private address inside
 * the deployment (e.g. an /etc/hosts entry for the instance's own domain) and
 * is therefore, correctly, rejected by the SSRF-safe network dispatcher.
 *
 * Returns the local file path for a first-party upload URL, or the input
 * unchanged for anything else (remote URLs, missing files, path traversal).
 */
export function resolveLocalUploadPath(path: string): string {
  if (!/^https?:\/\//i.test(path)) return path;

  const frontendUrl = process.env.FRONTEND_URL?.trim();
  const uploadDirectory = process.env.UPLOAD_DIRECTORY?.trim();
  if (!frontendUrl || !uploadDirectory) return path;

  try {
    const mediaUrl = new URL(path);
    const frontendOrigin = new URL(frontendUrl).origin;
    if (
      mediaUrl.origin !== frontendOrigin ||
      !mediaUrl.pathname.startsWith('/uploads/')
    ) {
      return path;
    }

    const base = resolve(uploadDirectory);
    const candidate = resolve(
      base,
      decodeURIComponent(mediaUrl.pathname.slice('/uploads/'.length))
    );
    if (candidate === base || !candidate.startsWith(base + sep)) return path;

    return statSync(candidate).isFile() ? candidate : path;
  } catch {
    return path;
  }
}

/** True when resolveLocalUploadPath found the file on disk. */
export function isLocalUploadPath(original: string, resolved: string) {
  return resolved !== original && !/^https?:\/\//i.test(resolved);
}
