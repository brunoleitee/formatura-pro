import type { Photo } from '../services/api';

export function extractSubfolders(photos: Photo[], catalogName: string): string[] {
  const folders = new Set<string>();
  for (const photo of photos) {
    const pathParts = photo.path.split(/[/\\]/);
    if (pathParts.length > 1) {
      const catalogIndex = pathParts.findIndex((p: string) => p === catalogName);
      if (catalogIndex >= 0 && catalogIndex + 1 < pathParts.length - 1) {
        folders.add(pathParts[catalogIndex + 1]);
      }
    }
  }
  return Array.from(folders).sort();
}
