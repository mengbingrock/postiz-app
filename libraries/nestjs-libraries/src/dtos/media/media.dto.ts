import {
  IsDefined,
  IsString,
  IsUrl,
  ValidateIf,
  Validate,
  IsInt,
  Min,
  Max,
  IsOptional,
} from 'class-validator';
import {
  ValidUrlExtension,
  ValidUrlPath,
} from '@gitroom/helpers/utils/valid.url.path';

export class MediaDto {
  @IsString()
  @IsDefined()
  id: string;

  @IsString()
  @IsDefined()
  @Validate(ValidUrlPath)
  @Validate(ValidUrlExtension)
  path: string;

  @ValidateIf((o) => o.alt)
  @IsString()
  alt?: string;

  @ValidateIf((o) => o.thumbnail)
  @IsUrl()
  thumbnail?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  thumbnailTimestamp?: number;
}
