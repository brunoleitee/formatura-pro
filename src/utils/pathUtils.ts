import type { Photo } from '../services/api';
import { getPhotoSubfolder } from './catalogPathUtils';

const INTERNAL_DIRS = new Set([
  '.git', '.github', 'node_modules', 'src', 'backend', 'frontend',
  'dist', 'build', 'target', '__pycache__', '.cache', '.temp',
  'assets', 'examples', 'images', 'lossless_images', 'cargo_toml',
  'thumbs', 'thumbnails', 'icons', 'favicon', 'public', 'static',
]);

export function extractSubfolders(photos: Photo[]): string[] {
  const raw = photos
    .map(photo => getPhotoSubfolder(photo))
    .filter(Boolean) as string[];

  const unique = Array.from(new Set(raw))
    .filter(s => !INTERNAL_DIRS.has(s.toLowerCase()) && s.length > 1)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));

  if (unique.length === 0 && raw.length > 0) {
    console.log('[CatalogTree] all subfolders rejected:', raw);
  }

  return unique;
}
