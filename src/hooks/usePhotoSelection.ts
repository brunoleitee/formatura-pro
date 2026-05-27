import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { Photo } from '../services/api';

export interface IdentifiablePhoto {
  rowid?: number | string;
  id?: number | string;
  original_path?: string;
  originalPath?: string;
  file_path?: string;
  filePath?: string;
  path?: string;
}

export function getPhotoId(photo: IdentifiablePhoto) {
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
  const lastSelectedIdRef = useRef<string | null>(null);
  const orderedIdsRef = useRef<string[]>([]);

  useEffect(() => {
    orderedIdsRef.current = photos.map(getPhotoId);
    if (lastSelectedIdRef.current && !orderedIdsRef.current.includes(lastSelectedIdRef.current)) {
      lastSelectedIdRef.current = null;
    }
  }, [photos]);

  const toggleSelection = useCallback((photo: Photo, event: React.MouseEvent | React.KeyboardEvent) => {
    const id = getPhotoId(photo);
    const orderedIds = orderedIdsRef.current;
    const currentIndex = orderedIds.indexOf(id);
    const anchorId = lastSelectedIdRef.current;
    const anchorIndex = anchorId ? orderedIds.indexOf(anchorId) : -1;
    const hasRange = Boolean(event.shiftKey && anchorIndex >= 0 && currentIndex >= 0);

    setSelectedPaths(prev => {
      const next = new Set(prev);

      if (hasRange) {
        const [from, to] = anchorIndex < currentIndex ? [anchorIndex, currentIndex] : [currentIndex, anchorIndex];
        for (const itemId of orderedIds.slice(from, to + 1)) {
          next.add(itemId);
        }
        return next;
      }

      if (event.ctrlKey || event.metaKey) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }

      if (next.has(id) && next.size === 1) {
        next.clear();
      } else {
        next.clear();
        next.add(id);
      }

      return next;
    });

    lastSelectedIdRef.current = id;
  }, []);

  const clearSelection = useCallback(() => {
    lastSelectedIdRef.current = null;
    setSelectedPaths(new Set());
  }, []);

  return {
    selectedPaths,
    setSelectedPaths,
    toggleSelection,
    clearSelection,
  };
}
