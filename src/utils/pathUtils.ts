import type { Photo } from '../services/api';
import { getPhotoSubfolder } from './catalogPathUtils';

export function extractSubfolders(photos: Photo[]): string[] {
  const subfolders = Array.from(
    new Set(
      photos
        .map(photo => getPhotoSubfolder(photo))
        .filter(Boolean) as string[]
    )
  ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

  return subfolders;
}
