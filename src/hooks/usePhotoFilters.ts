import { useState, useMemo } from 'react';
import type { Photo } from '../services/api';
import { isPhotoMapped, isPhotoUnmapped } from '../utils/personIdentity';
import { getPhotoSubfolder, sameSubfolder } from '../utils/catalogPathUtils';

export type PhotoFilter = 'all' | 'mapped' | 'unmapped';

export function usePhotoFilters(photos: Photo[], currentCatalog: string, selectedSubfolder: string | null, hideDiscarded = false) {
  const [filter, setFilter] = useState<PhotoFilter>('all');

  const filteredPhotos = useMemo(() => {
    let result = photos.filter(p => {
      if (hideDiscarded && p.discarded) return false;

      if (selectedSubfolder) {
        const photoSubfolder = getPhotoSubfolder(p);
        if (!sameSubfolder(photoSubfolder, selectedSubfolder)) return false;
      }

      if (filter === 'mapped') return isPhotoMapped(p);
      if (filter === 'unmapped') return isPhotoUnmapped(p);
      return true;
    });

    return result;
  }, [photos, currentCatalog, selectedSubfolder, filter, hideDiscarded]);

  return { filter, setFilter, filteredPhotos };
}