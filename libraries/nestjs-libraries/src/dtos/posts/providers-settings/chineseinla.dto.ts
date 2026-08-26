import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class ChineseInLADto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsDefined()
  forumId: number;

  @IsString()
  @IsIn(['question', 'classified', 'other'])
  @IsDefined()
  postType: 'question' | 'classified' | 'other';

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @IsDefined()
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  tags?: string;

  @ValidateIf((settings) => Boolean(settings.sourceUrl))
  @IsString()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  sourceUrl?: string;

  @ValidateIf((settings) => Boolean(settings.preparedDraftId))
  @IsString()
  @Matches(/^[a-f0-9]{32}$/i)
  preparedDraftId?: string;
}
