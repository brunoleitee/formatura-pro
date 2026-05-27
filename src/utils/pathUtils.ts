import type { Photo } from '../services/api';
import { getPhotoSubfolder, BLOCKED_DIRS } from './catalogPathUtils';

export function extractSubfolders(photos: Photo[]): string[] {
  const raw = photos
    .map(photo => getPhotoSubfolder(photo))
    .filter(Boolean) as string[];

  const unique = Array.from(new Set(raw))
    .filter(s => !BLOCKED_DIRS.has(s.toLowerCase()) && s.length > 1)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));

  if (unique.length === 0 && raw.length > 0) {
    console.log('[CatalogTree] all subfolders rejected:', raw);
  }

  return unique;
}
