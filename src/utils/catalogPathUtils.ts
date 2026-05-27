export const BLOCKED_DIRS = new Set([
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

export function findCommonPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  
  const normalizedPaths = paths
    .map(p => normalizePath(p))
    .filter(p => p && p.includes('/'));
  
  if (normalizedPaths.length === 0) return '';
  if (normalizedPaths.length === 1) {
    const p = normalizedPaths[0];
    const lastSlash = p.lastIndexOf('/');
    return lastSlash >= 0 ? p.slice(0, lastSlash) : p;
  }
  
  const splitPaths = normalizedPaths.map(p => p.split('/'));
  let minLen = Infinity;
  for (const sp of splitPaths) {
    if (sp.length < minLen) minLen = sp.length;
  }
  
  let commonSegmentsCount = 0;
  for (let i = 0; i < minLen; i++) {
    const segment = splitPaths[0][i];
    let allMatch = true;
    for (let j = 1; j < splitPaths.length; j++) {
      if (splitPaths[j][i].toLowerCase() !== segment.toLowerCase()) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      commonSegmentsCount++;
    } else {
      break;
    }
  }
  
  if (commonSegmentsCount === 0) return '';
  return splitPaths[0].slice(0, commonSegmentsCount).join('/');
}

export function getPhotoSubfolderRelative(photo: any, prefix: string): string | null {
  const normalized = getPhotoPath(photo);
  if (!normalized) return null;
  
  const normPrefix = normalizePath(prefix);
  
  if (normPrefix && normalized.toLowerCase().startsWith(normPrefix.toLowerCase() + '/')) {
    const relative = normalized.slice(normPrefix.length + 1);
    const parts = relative.split('/').filter(Boolean);
    if (parts.length > 1) {
      return parts.slice(0, -1).join('/');
    }
    return null;
  }
  
  return getPhotoSubfolder(photo);
}

export function isSubfolderMatch(photoSubfolder: string | null, selectedSubfolder: string | null): boolean {
  if (!photoSubfolder && !selectedSubfolder) return true;
  if (!photoSubfolder || !selectedSubfolder) return false;
  
  const ps = photoSubfolder.trim().toLowerCase().replaceAll('\\', '/');
  const sel = selectedSubfolder.trim().toLowerCase().replaceAll('\\', '/');
  
  return ps === sel || ps.startsWith(sel + '/');
}

