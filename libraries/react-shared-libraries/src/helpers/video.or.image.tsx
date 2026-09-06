import { FC } from 'react';
import { clsx } from 'clsx';
import { hasVideoExtension } from '@gitroom/helpers/utils/has.extension';
export const VideoOrImage: FC<{
  src: string;
  autoplay: boolean;
  mediaPath?: string;
  poster?: string;
  isContain?: boolean;
  imageClassName?: string;
  videoClassName?: string;
}> = (props) => {
  const {
    src,
    autoplay,
    mediaPath,
    poster,
    isContain,
    imageClassName,
    videoClassName,
  } = props;
  if (hasVideoExtension(mediaPath || src)) {
    return (
      <video
        src={src}
        poster={poster}
        autoPlay={autoplay}
        className={clsx('w-full h-full', videoClassName)}
        muted={true}
        loop={true}
        playsInline={true}
      />
    );
  }
  return (
    <img
      className={clsx(
        isContain ? 'object-contain' : 'object-cover',
        'w-full h-full',
        imageClassName
      )}
      src={src}
    />
  );
};
