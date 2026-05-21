import type { CloudItem } from './types';
import { normalizeFolderName } from './normalizeFolderName';

const referenceTokens = ['#BASE', 'BASE', 'REFERENCIA'];

export function detectReferenceFolders(items: CloudItem[]) {
  return items.filter(item => {
    if (!item.isFolder) return false;
    const normalized = normalizeFolderName(item.name);
    return referenceTokens.some(token => normalized.includes(token));
  });
}
