import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { Readable } from 'node:stream';
import { IUploadProvider } from './upload.interface';

const execFileAsync = promisify(execFile);

const videoExtension = (mimeType: string) => {
  if (mimeType === 'video/quicktime') return 'mov';
  if (mimeType === 'video/mpeg') return 'mpg';
  return 'mp4';
};

export async function createVideoThumbnail(
  buffer: Buffer,
  mimeType: string
): Promise<Buffer | undefined> {
  if (!mimeType.startsWith('video/')) return undefined;

  const directory = await mkdtemp(join(tmpdir(), 'postiz-video-thumbnail-'));
  const input = join(directory, `source.${videoExtension(mimeType)}`);
  const output = join(directory, 'thumbnail.jpg');

  try {
    await writeFile(input, buffer);
    await execFileAsync(
      process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        input,
        '-ss',
        '0.1',
        '-frames:v',
        '1',
        '-vf',
        'scale=640:640:force_original_aspect_ratio=decrease',
        '-q:v',
        '3',
        '-y',
        output,
      ],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }
    );
    return await readFile(output);
  } catch (error) {
    console.warn(
      `Could not generate video thumbnail: ${
        error instanceof Error ? error.message : 'Unexpected FFmpeg error'
      }`
    );
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function createAndUploadVideoThumbnail(
  storage: IUploadProvider,
  file: Express.Multer.File
): Promise<string | undefined> {
  try {
    const thumbnail = await createVideoThumbnail(file.buffer, file.mimetype);
    if (!thumbnail) return undefined;

    const uploaded = await storage.uploadFile({
      buffer: thumbnail,
      mimetype: 'image/jpeg',
      size: thumbnail.length,
      path: '',
      fieldname: 'file',
      destination: '',
      stream: Readable.from(thumbnail),
      filename: 'thumbnail.jpg',
      originalname: 'thumbnail.jpg',
      encoding: '7bit',
    });

    return uploaded.path;
  } catch (error) {
    console.warn(
      `Could not save video thumbnail: ${
        error instanceof Error ? error.message : 'Unexpected storage error'
      }`
    );
    return undefined;
  }
}
