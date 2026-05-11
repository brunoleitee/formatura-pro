import { useState, useEffect } from 'react';
import type { Photo } from '../services/api';

export function usePhotoViewer(filteredPhotos: Photo[]) {
  const [viewerPhoto, setViewerPhoto] = useState<Photo | null>(null);

  useEffect(() => {
    if (!viewerPhoto) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setViewerPhoto(null);
      } else if (e.key === 'ArrowLeft') {
        const idx = filteredPhotos.findIndex(p => p.path === viewerPhoto.path);
        if (idx > 0) setViewerPhoto(filteredPhotos[idx - 1]);
      } else if (e.key === 'ArrowRight') {
        const idx = filteredPhotos.findIndex(p => p.path === viewerPhoto.path);
        if (idx < filteredPhotos.length - 1) setViewerPhoto(filteredPhotos[idx + 1]);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [viewerPhoto, filteredPhotos]);

  return {
    viewerPhoto,
    setViewerPhoto
  };
}
