import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RedNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @IsDefined()
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  tags?: string;

  @IsOptional()
  @IsString()
  @IsIn(['公开可见', '仅自己可见', '仅互关好友可见'])
  visibility?: string;

  @IsOptional()
  @IsBoolean()
  original?: boolean;
}
