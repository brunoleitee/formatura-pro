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

export function usePhotoSelection(photos: Photo[]) {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const toggleSelection = useCallback((photo: Photo, event: React.MouseEvent | React.KeyboardEvent) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      const path = getPhotoId(photo);

      if (event.ctrlKey || event.metaKey) {
        if (next.has(path)) next.delete(path);
        else next.add(path);
      } else if (event.shiftKey && prev.size > 0) {
        const allPaths = photos.map(getPhotoId);
        // Find the last selected path that is actually in the current view
        const prevArray = Array.from(prev);
        let lastSelectedPath = '';
        for (let i = prevArray.length - 1; i >= 0; i--) {
          if (allPaths.includes(prevArray[i])) {
            lastSelectedPath = prevArray[i];
            break;
          }
        }
        
        const startIdx = allPaths.indexOf(lastSelectedPath);
        const endIdx = allPaths.indexOf(path);
        
        if (startIdx !== -1 && endIdx !== -1) {
          const [low, high] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          for (let i = low; i <= high; i++) {
            next.add(allPaths[i]);
          }
        } else {
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
  }, [photos]);

  const clearSelection = useCallback(() => setSelectedPaths(new Set()), []);

  return {
    selectedPaths,
    setSelectedPaths,
    toggleSelection,
    clearSelection
  };
}
