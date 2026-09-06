import {
  ValidationArguments,
  ValidatorConstraintInterface,
  ValidatorConstraint,
} from 'class-validator';

@ValidatorConstraint({ name: 'checkValidExtension', async: false })
export class ValidUrlExtension implements ValidatorConstraintInterface {
  validate(text: string, args: ValidationArguments) {
    const path = text?.split?.(/[?#]/)?.[0]?.toLowerCase();
    return [
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.webp',
      '.mp4',
      '.mov',
      '.mpeg',
      '.mpg',
    ].some((extension) => path?.endsWith(extension));
  }

  defaultMessage(args: ValidationArguments) {
    // here you can provide default error message if validation failed
    return 'File must have a valid extension: .png, .jpg, .jpeg, .gif, .webp, .mp4, .mov, .mpeg, or .mpg';
  }
}

@ValidatorConstraint({ name: 'checkValidPath', async: false })
export class ValidUrlPath implements ValidatorConstraintInterface {
  validate(text: string, args: ValidationArguments) {
    if (!process.env.RESTRICT_UPLOAD_DOMAINS) {
      return true;
    }

    return (
      (text || 'invalid url').indexOf(process.env.RESTRICT_UPLOAD_DOMAINS) > -1
    );
  }

  defaultMessage(args: ValidationArguments) {
    // here you can provide default error message if validation failed
    return (
      'URL must contain the domain: ' +
      process.env.RESTRICT_UPLOAD_DOMAINS +
      ' Make sure you first use the upload API route.'
    );
  }
}
