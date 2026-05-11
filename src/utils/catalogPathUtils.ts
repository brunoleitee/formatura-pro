export function normalizePath(value: unknown): string {
  return String(value || '').replaceAll('\\', '/').trim();
}

export function getPhotoPath(photo: any): string {
  return normalizePath(
    photo.relative_path ||
    photo.relativePath ||
    photo.original_path ||
    photo.originalPath ||
    photo.file_path ||
    photo.filePath ||
    photo.path ||
    photo.src ||
    photo.thumbnail_url ||
    ''
  );
}

export function getPhotoSubfolder(photo: any): string | null {
  const normalized = getPhotoPath(photo);
  if (!normalized) return null;

  const lower = normalized.toLowerCase();

  const fotosIndex = lower.lastIndexOf('/fotos/');
  if (fotosIndex >= 0) {
    const afterFotos = normalized.slice(fotosIndex + '/fotos/'.length);
    const parts = afterFotos.split('/').filter(Boolean);
    return parts.length > 1 ? parts[0] : null;
  }

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return parts[parts.length - 2];
  }

  return null;
}

export function sameSubfolder(a: string | null | undefined, b: string | null | undefined): boolean {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}