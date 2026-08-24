import {
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MediaDto } from '@gitroom/nestjs-libraries/dtos/media/media.dto';

export class TajimaWebsiteDto {
  @IsString()
  @MinLength(2)
  @MaxLength(180)
  @IsDefined()
  title: string;

  @IsString()
  @MinLength(50)
  @MaxLength(300)
  @IsDefined()
  description: string;

  @IsOptional()
  @IsString()
  @ValidateIf((settings) => Boolean(settings.slug))
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Use lowercase letters, numbers, and hyphens only',
  })
  slug?: string;

  @IsString()
  @IsIn([
    'chase-tajima',
    'jackie-levien',
    'ryan-duckett',
    'lisa-dale',
    'patrick-yoo',
    'david-song',
    'tajima-llp',
  ])
  @IsDefined()
  author: string;

  @IsString()
  @MinLength(2)
  @MaxLength(240)
  @IsDefined()
  categories: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MediaDto)
  main_image?: MediaDto;
}
