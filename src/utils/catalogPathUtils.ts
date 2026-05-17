const BLOCKED_DIRS = new Set([
  '.git', '.github', 'node_modules', 'src', 'backend', 'frontend',
  'dist', 'build', 'target', '__pycache__', '.cache', '.temp',
  'assets', 'examples', 'images', 'lossless_images', 'cargo_toml',
  'thumbs', 'thumbnails', 'icons', 'favicon', 'public', 'static',
]);

export function normalizePath(value: unknown): string {
  return String(value || '').replaceAll('\\', '/').trim();
}

export function getPhotoPath(photo: any): string {
  return normalizePath(
    photo.original_path ||
    photo.originalPath ||
    photo.relative_path ||
    photo.relativePath ||
    photo.file_path ||
    photo.filePath ||
    photo.path ||
    photo.src ||
    ''
  );
}

export function getPhotoSubfolder(photo: any): string | null {
  const normalized = getPhotoPath(photo);
  if (!normalized) return null;

  // Só considera paths absolutos com separador
  const lower = normalized.toLowerCase();

  // Tenta encontrar /fotos/ no path
  const fotosIndex = lower.lastIndexOf('/fotos/');
  if (fotosIndex >= 0) {
    const afterFotos = normalized.slice(fotosIndex + '/fotos/'.length);
    const parts = afterFotos.split('/').filter(Boolean);
    if (parts.length > 1 && !BLOCKED_DIRS.has(parts[0].toLowerCase())) {
      return parts[0];
    }
    return null;
  }

  // Fallback seguro: pega o diretório pai do arquivo de foto
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length >= 2) {
    // Verifica se parece um caminho de arquivo válido (tem extensão)
    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    if (last.includes('.') && !secondLast.includes('.') && secondLast.length > 1) {
      if (!BLOCKED_DIRS.has(secondLast.toLowerCase())) {
        return secondLast;
      }
    }
  }

  return null;
}

export function sameSubfolder(a: string | null | undefined, b: string | null | undefined): boolean {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}
