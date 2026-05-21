import type { CloudCatalog, CloudEventDraft } from './types';

export function catalogToDraft(catalog: CloudCatalog): CloudEventDraft {
  return {
    id: catalog.id,
    source: catalog.source,
    name: catalog.name,
    provider: catalog.provider,
    sourceFolderId: catalog.sourceFolderId,
    sourceFolderName: catalog.sourceFolderName,
    references: catalog.references,
    totalFiles: catalog.totalFiles,
    subfolderCount: catalog.subfolderCount,
    mode: catalog.mode,
    status: catalog.status,
    createdAt: catalog.createdAt,
    updatedAt: catalog.updatedAt,
    cacheEnabled: catalog.cacheEnabled,
    cacheSize: catalog.cacheSize,
    lastSync: catalog.lastSync,
  };
}

export function draftToCatalog(draft: CloudEventDraft): CloudCatalog | null {
  if (!draft.id) return null;
  const now = new Date().toISOString();
  return {
    ...draft,
    id: draft.id,
    source: draft.source ?? 'cloud',
    cacheEnabled: draft.cacheEnabled ?? true,
    cacheSize: draft.cacheSize ?? 0,
    lastSync: draft.lastSync ?? draft.updatedAt ?? now,
    createdAt: draft.createdAt ?? now,
    updatedAt: draft.updatedAt ?? now,
  };
}
