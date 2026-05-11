import { useState, useRef } from 'react';
import type { Photo } from '../services/api';

export function usePhotoSelection() {
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const lastClickTime = useRef<number>(0);
  const lastClickPhoto = useRef<string>('');

  const handlePhotoClick = (photo: Photo, onDoubleClick: (photo: Photo) => void) => {
    const now = Date.now();
    const timeSinceLastClick = now - lastClickTime.current;
    
    if (timeSinceLastClick < 300 && lastClickPhoto.current === photo.path) {
      onDoubleClick(photo);
      lastClickTime.current = 0;
    } else {
      lastClickTime.current = now;
      lastClickPhoto.current = photo.path;
      setSelectedPhoto(selectedPhoto?.path === photo.path ? null : photo);
    }
  };

  return {
    selectedPhoto,
    setSelectedPhoto,
    handlePhotoClick
  };
}
