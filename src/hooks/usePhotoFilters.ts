import { useState, useMemo } from 'react';
import type { Photo } from '../services/api';
import { isPhotoMapped, isPhotoUnmapped } from '../utils/personIdentity';

export type PhotoFilter = 'all' | 'mapped' | 'unmapped';

export function usePhotoFilters(photos: Photo[], currentCatalog: string, selectedSubfolder: string | null) {
  const [filter, setFilter] = useState<PhotoFilter>('all');

  const filteredPhotos = useMemo(() => {
    return photos.filter(p => {
      if (p.discarded) return false;

      if (selectedSubfolder) {
        const parts = p.path.split(/[/\\]/);
        const ci = parts.findIndex(part => part === currentCatalog);
        if (ci < 0 || parts[ci + 1] !== selectedSubfolder) return false;
      }

      if (filter === 'mapped') return isPhotoMapped(p);
      if (filter === 'unmapped') return isPhotoUnmapped(p);
      return true;
    });
  }, [photos, currentCatalog, selectedSubfolder, filter]);

  return { filter, setFilter, filteredPhotos };
}
