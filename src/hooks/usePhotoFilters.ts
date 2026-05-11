import { useState, useMemo } from 'react';
import type { Photo } from '../services/api';
import { extractSubfolders } from '../utils/pathUtils';
import { isPhotoMapped, isPhotoUnmapped } from '../utils/photoMapping';

export type PhotoFilter = 'all' | 'mapped' | 'unmapped';

export function usePhotoFilters(photos: Photo[], currentCatalog: string) {
  const [filter, setFilter] = useState<PhotoFilter>('all');
  const [selectedSubfolder, setSelectedSubfolder] = useState<string | null>(null);

  const subfolders = useMemo(() => extractSubfolders(photos, currentCatalog), [photos, currentCatalog]);

  const filteredPhotos = useMemo(() => {
    return photos.filter(p => {
      if (selectedSubfolder) {
        const pathParts = p.path.split(/[/\\]/);
        const catalogIndex = pathParts.findIndex(part => part === currentCatalog);
        if (catalogIndex < 0 || pathParts[catalogIndex + 1] !== selectedSubfolder) return false;
      }
      if (filter === 'mapped') return isPhotoMapped(p);
      if (filter === 'unmapped') return isPhotoUnmapped(p);
      return true;
    });
  }, [photos, currentCatalog, filter, selectedSubfolder]);

  return {
    filter,
    setFilter,
    selectedSubfolder,
    setSelectedSubfolder,
    subfolders,
    filteredPhotos
  };
}
