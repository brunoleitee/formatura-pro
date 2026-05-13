import { useState, useEffect, useRef, useCallback } from 'react';
import type { Photo } from '../services/api';

export function usePhotoViewer(filteredPhotos: Photo[]) {
  const [viewerPhoto, setViewerPhoto] = useState<Photo | null>(null);
  const filteredPhotosRef = useRef(filteredPhotos);
  const viewerPhotoRef = useRef<Photo | null>(null);

  useEffect(() => {
    filteredPhotosRef.current = filteredPhotos;
  }, [filteredPhotos]);

  useEffect(() => {
    viewerPhotoRef.current = viewerPhoto;
  }, [viewerPhoto]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const currentPhoto = viewerPhotoRef.current;
    const photos = filteredPhotosRef.current;
    if (!currentPhoto) return;

    if (e.key === 'Escape') {
      setViewerPhoto(null);
    } else if (e.key === 'ArrowLeft') {
      const idx = photos.findIndex(p => p.path === currentPhoto.path);
      if (idx > 0) setViewerPhoto(photos[idx - 1]);
    } else if (e.key === 'ArrowRight') {
      const idx = photos.findIndex(p => p.path === currentPhoto.path);
      if (idx < photos.length - 1) setViewerPhoto(photos[idx + 1]);
    }
  }, []);

  useEffect(() => {
    if (!viewerPhoto) return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown, viewerPhoto]);

  return {
    viewerPhoto,
    setViewerPhoto,
  };
}
