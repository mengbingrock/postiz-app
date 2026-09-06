import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { ApiTags } from '@nestjs/swagger';
import handleR2Upload from '@gitroom/nestjs-libraries/upload/r2.uploader';
import { FileInterceptor } from '@nestjs/platform-express';
import { CustomFileValidationPipe } from '@gitroom/nestjs-libraries/upload/custom.upload.validation';
import { SubscriptionService } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { SaveMediaInformationDto } from '@gitroom/nestjs-libraries/dtos/media/save.media.information.dto';
import { VideoDto } from '@gitroom/nestjs-libraries/dtos/videos/video.dto';
import { VideoFunctionDto } from '@gitroom/nestjs-libraries/dtos/videos/video.function.dto';
import { createAndUploadVideoThumbnail } from '@gitroom/nestjs-libraries/upload/video.thumbnail';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

@ApiTags('Media')
@Controller('/media')
export class MediaController {
  private storage = UploadFactory.createStorage();
  constructor(
    private _mediaService: MediaService,
    private _subscriptionService: SubscriptionService
  ) {}

  private async sendLocalMedia(
    mediaUrl: string,
    res: Response,
    notFoundMessage: string
  ) {
    let storedUrl: URL;
    let frontendUrl: URL;
    try {
      storedUrl = new URL(mediaUrl);
      frontendUrl = new URL(process.env.FRONTEND_URL!);
    } catch {
      throw new NotFoundException(notFoundMessage);
    }

    if (storedUrl.origin !== frontendUrl.origin) {
      return res.redirect(storedUrl.toString());
    }

    if (!storedUrl.pathname.startsWith('/uploads/')) {
      throw new NotFoundException(notFoundMessage);
    }

    const base = resolve(process.env.UPLOAD_DIRECTORY!);
    let filePath: string;
    try {
      filePath = resolve(
        base,
        decodeURIComponent(storedUrl.pathname.slice('/uploads/'.length))
      );
    } catch {
      throw new NotFoundException(notFoundMessage);
    }
    if (filePath === base || !filePath.startsWith(base + sep)) {
      throw new NotFoundException(notFoundMessage);
    }

    const fileStats = await stat(filePath).catch(() => undefined);
    if (!fileStats?.isFile()) throw new NotFoundException(notFoundMessage);

    res.type(filePath);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(filePath);
  }

  @Get('/:id/content')
  async mediaContent(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Res() res: Response
  ) {
    const media = await this._mediaService.getMediaByIdForOrg(org.id, id);
    if (!media?.path) throw new NotFoundException('Media not found.');

    return this.sendLocalMedia(media.path, res, 'Media not found.');
  }

  @Get('/:id/preview')
  async previewMedia(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Res() res: Response
  ) {
    const media = await this._mediaService.getMediaByIdForOrg(org.id, id);
    if (!media?.thumbnail) throw new NotFoundException('Preview not found.');

    return this.sendLocalMedia(media.thumbnail, res, 'Preview not found.');
  }

  @Delete('/:id')
  deleteMedia(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return this._mediaService.deleteMedia(org.id, id);
  }

  @Post('/generate-video')
  generateVideo(
    @GetOrgFromRequest() org: Organization,
    @Body() body: VideoDto
  ) {
    console.log('hello');
    return this._mediaService.generateVideo(org, body);
  }

  @Post('/generate-image')
  async generateImage(
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request,
    @Body('prompt') prompt: string,
    isPicturePrompt = false
  ) {
    const total = await this._subscriptionService.checkCredits(org);
    if (process.env.STRIPE_PUBLISHABLE_KEY && total.credits <= 0) {
      return false;
    }

    return {
      output:
        'data:image/png;base64,' +
        (await this._mediaService.generateImage(prompt, org, isPicturePrompt)),
    };
  }

  @Post('/generate-image-with-prompt')
  async generateImageFromText(
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request,
    @Body('prompt') prompt: string
  ) {
    const image = await this.generateImage(org, req, prompt, true);
    if (!image) {
      return false;
    }

    const file = await this.storage.uploadSimple(image.output);

    return this._mediaService.saveFile(org.id, file.split('/').pop(), file);
  }

  @Post('/upload-server')
  @UseInterceptors(FileInterceptor('file'))
  @UsePipes(new CustomFileValidationPipe())
  async uploadServer(
    @GetOrgFromRequest() org: Organization,
    @UploadedFile() file: Express.Multer.File
  ) {
    const originalName = file?.originalname || '';
    const uploadedFile = await this.storage.uploadFile(file);
    const thumbnail = await createAndUploadVideoThumbnail(this.storage, file);
    return this._mediaService.saveFile(
      org.id,
      uploadedFile.originalname,
      uploadedFile.path,
      originalName,
      {
        thumbnail,
        type: file.mimetype.startsWith('video/') ? 'video' : 'image',
        fileSize: file.size,
      }
    );
  }

  @Post('/save-media')
  async saveMedia(
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request,
    @Body('name') name: string,
    @Body('originalName') originalName: string
  ) {
    if (!name) {
      return false;
    }
    return this._mediaService.saveFile(
      org.id,
      name,
      process.env.CLOUDFLARE_BUCKET_URL + '/' + name,
      originalName || undefined
    );
  }

  @Post('/information')
  saveMediaInformation(
    @GetOrgFromRequest() org: Organization,
    @Body() body: SaveMediaInformationDto
  ) {
    return this._mediaService.saveMediaInformation(org.id, body);
  }

  @Post('/upload-simple')
  @UseInterceptors(FileInterceptor('file'))
  @UsePipes(new CustomFileValidationPipe())
  async uploadSimple(
    @GetOrgFromRequest() org: Organization,
    @UploadedFile('file') file: Express.Multer.File,
    @Body('preventSave') preventSave: string = 'false'
  ) {
    const originalName = file.originalname;
    const getFile = await this.storage.uploadFile(file);

    if (preventSave === 'true') {
      const { path } = getFile;
      return { path };
    }

    const thumbnail = await createAndUploadVideoThumbnail(this.storage, file);

    return this._mediaService.saveFile(
      org.id,
      getFile.originalname,
      getFile.path,
      originalName,
      {
        thumbnail,
        type: file.mimetype.startsWith('video/') ? 'video' : 'image',
        fileSize: file.size,
      }
    );
  }

  @Post('/:endpoint')
  async uploadFile(
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request,
    @Res() res: Response,
    @Param('endpoint') endpoint: string
  ) {
    const upload = await handleR2Upload(endpoint, req, res);
    if (endpoint !== 'complete-multipart-upload') {
      return upload;
    }

    // @ts-ignore
    const name = upload.Location.split('/').pop();
    const originalName = req.body?.file?.name;

    const saveFile = await this._mediaService.saveFile(
      org.id,
      name,
      // @ts-ignore
      upload.Location,
      originalName || undefined
    );

    res.status(200).json({ ...upload, saved: saveFile });
  }

  @Get('/')
  getMedia(
    @GetOrgFromRequest() org: Organization,
    @Query('page') page: number,
    @Query('search') search?: string
  ) {
    return this._mediaService.getMedia(org.id, page, search);
  }

  @Get('/video-options')
  getVideos() {
    return this._mediaService.getVideoOptions();
  }

  @Post('/video/function')
  videoFunction(@Body() body: VideoFunctionDto) {
    return this._mediaService.videoFunction(
      body.identifier,
      body.functionName,
      body.params
    );
  }

  @Get('/generate-video/:type/allowed')
  generateVideoAllowed(
    @GetOrgFromRequest() org: Organization,
    @Param('type') type: string
  ) {
    return this._mediaService.generateVideoAllowed(org, type);
  }
}
