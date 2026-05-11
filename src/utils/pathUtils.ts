import type { Photo } from '../services/api';

function getCatalogSubfolder(photo: Photo): string | null {
  const rawPath =
    (photo as any).relative_folder ||
    (photo as any).subfolder ||
    (photo as any).folder ||
    (photo as any).original_path ||
    photo.path ||
    (photo as any).file_path ||
    (photo as any).src ||
    '';

  if (!rawPath) return null;

  const normalized = rawPath.replaceAll('\\', '/');

  // Procurar pasta logo abaixo de /fotos/
  const fotosIndex = normalized.toLowerCase().lastIndexOf('/fotos/');
  if (fotosIndex >= 0) {
    const afterFotos = normalized.slice(fotosIndex + '/fotos/'.length);
    const parts = afterFotos.split('/').filter(Boolean);
    return parts.length > 1 ? parts[0] : null;
  }

  // Fallback: tentar pegar a pasta pai do arquivo
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return parts[parts.length - 2];
  }

  return null;
}

export function extractSubfolders(photos: Photo[]): string[] {
  const subfolders = Array.from(
    new Set(
      photos
        .map(photo => getCatalogSubfolder(photo))
        .filter(Boolean) as string[]
    )
  ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

  return subfolders;
}
