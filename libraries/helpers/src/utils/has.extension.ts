export const hasExtension = (
  path: string | undefined | null,
  extension: string
): boolean => {
  if (!path) {
    return false;
  }
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return path.toLowerCase().indexOf(ext.toLowerCase()) > -1;
};

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mpeg', 'mpg'];

export const hasVideoExtension = (path: string | undefined | null): boolean => {
  if (!path) return false;
  const cleanPath = path.split(/[?#]/)[0].toLowerCase();
  return VIDEO_EXTENSIONS.some((extension) =>
    cleanPath.endsWith(`.${extension}`)
  );
};
