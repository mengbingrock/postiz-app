import { useCallback } from 'react';
export const useMediaDirectory = () => {
  const set = useCallback((path: string, mediaId?: string) => {
    return mediaId ? `/api/media/${encodeURIComponent(mediaId)}/content` : path;
  }, []);
  return {
    set,
  };
};
