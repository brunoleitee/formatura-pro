import React, { useState, useCallback } from 'react';
import type { Photo } from '../services/api';

export function getPhotoId(photo: any) {
  const id = String(
    photo.rowid ??
    photo.id ??
    photo.original_path ??
    photo.originalPath ??
    photo.file_path ??
    photo.filePath ??
    photo.path
  );
  if (!id || id === 'undefined' || id === 'null') {
    console.warn('[Catalog missing photo id]', photo);
  }
  return id;
}

export function usePhotoSelection(_photos: Photo[]) {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const toggleSelection = useCallback((photo: Photo, event: React.MouseEvent | React.KeyboardEvent) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      const path = getPhotoId(photo);

      if (event.ctrlKey || event.metaKey) {
        if (next.has(path)) next.delete(path);
        else next.add(path);
      } else if (event.shiftKey) {
        console.warn('[Catalog] Shift range selection temporarily disabled');
        // Fallback para clique normal
        if (next.has(path) && next.size === 1) {
          next.clear();
        } else {
          next.clear();
          next.add(path);
        }
      } else {
        if (next.has(path) && next.size === 1) {
          next.clear();
        } else {
          next.clear();
          next.add(path);
        }
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedPaths(new Set()), []);

  return {
    selectedPaths,
    setSelectedPaths,
    toggleSelection,
    clearSelection
  };
}
