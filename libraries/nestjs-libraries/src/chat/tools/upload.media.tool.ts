import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import {
  decodeBase64Image,
  MAX_ENCODED_IMAGE_SIZE,
} from '@gitroom/nestjs-libraries/chat/tools/upload.media.input';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { Readable } from 'stream';
import { z } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fileTypeFromBuffer } = require('file-type');

const ALLOWED_IMAGE_MIME = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
]);

const safeOriginalName = (filename: string | undefined, extension: string) => {
  const base = (filename || 'upload')
    .replace(/\.[^./\\]*$/, '')
    .replace(/[\\/]/g, '_')
    .slice(0, 100);
  return `${base || 'upload'}.${extension}`;
};

@Injectable()
export class UploadMediaTool implements AgentToolInterface {
  private storage = UploadFactory.createStorage();

  constructor(private _mediaService: MediaService) {}
  name = 'uploadMediaTool';

  run() {
    return createTool({
      id: 'uploadMediaTool',
      description: `Upload image bytes directly into the Postiz media library using the MCP credential.
Accepts either raw base64 or a base64 data URL. Use the returned path as an attachment in integrationSchedulePostTool.
The actual file type is detected from the bytes; supported image types are JPEG, PNG, GIF, WebP, AVIF, BMP, and TIFF.`,
      mcp: {
        annotations: {
          title: 'Upload Image',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      inputSchema: z.object({
        data: z
          .string()
          .max(MAX_ENCODED_IMAGE_SIZE)
          .describe('Raw base64 image bytes or a base64 data URL'),
        filename: z
          .string()
          .max(255)
          .optional()
          .describe('Optional original filename for the media library'),
      }),
      outputSchema: z.object({
        id: z.string().optional(),
        path: z.string().optional(),
        error: z.string().optional(),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);

        try {
          const org = JSON.parse(
            (context?.requestContext as any)?.get('organization') as string
          );
          const buffer = decodeBase64Image(inputData.data);
          const detected = await fileTypeFromBuffer(buffer);

          if (!detected || !ALLOWED_IMAGE_MIME.has(detected.mime)) {
            return { error: 'Unsupported image type.' };
          }

          const originalName = safeOriginalName(
            inputData.filename,
            detected.ext
          );
          const uploaded = await this.storage.uploadFile({
            buffer,
            mimetype: detected.mime,
            size: buffer.length,
            path: '',
            fieldname: 'file',
            destination: '',
            stream: Readable.from(buffer),
            filename: originalName,
            originalname: originalName,
            encoding: '7bit',
          });

          return await this._mediaService.saveFile(
            org.id,
            uploaded.originalname,
            uploaded.path,
            originalName
          );
        } catch (error) {
          return {
            error: `Failed to upload image: ${
              error instanceof Error ? error.message : 'Unexpected error'
            }`,
          };
        }
      },
    });
  }
}
