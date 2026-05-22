import type { CloudItem } from './types';
import { normalizeFolderName } from './normalizeFolderName';

export function detectReferenceFolders(items: CloudItem[]) {
  return items.filter(item => {
    if (!item.isFolder) return false;
    const normalized = normalizeFolderName(item.name);
    return normalized.includes('BASE') || normalized.includes('REFERENCIA');
  });
}
