import { NextRequest } from 'next/server';
// @ts-ignore JavaScript helper is also exercised directly by Node's test runner.
import { serveLocalUpload } from '../../../../../local-upload-route.js';

type UploadContext = {
  params: Promise<{
    path?: string[];
  }>;
};

const handle = async (request: NextRequest, context: UploadContext) => {
  const { path } = await context.params;
  return serveLocalUpload(
    process.env.UPLOAD_DIRECTORY,
    path ?? [],
    request.method
  );
};

export const GET = handle;
export const HEAD = handle;
