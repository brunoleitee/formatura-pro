import type { CloudCatalog, CloudEventDraft } from './types';

export function catalogToDraft(catalog: CloudCatalog): CloudEventDraft {
  return {
    id: catalog.id,
    source: catalog.source,
    type: catalog.type,
    name: catalog.name,
    provider: catalog.provider,
    sourceFolderId: catalog.sourceFolderId,
    sourceFolderName: catalog.sourceFolderName,
    eventRootFolderId: catalog.eventRootFolderId,
    eventRootFolderName: catalog.eventRootFolderName,
    referencesFolderIds: catalog.referencesFolderIds,
    sourceBreadcrumb: catalog.sourceBreadcrumb,
    references: catalog.references,
    totalFiles: catalog.totalFiles,
    subfolderCount: catalog.subfolderCount,
    totalSubfolders: catalog.totalSubfolders ?? catalog.subfolderCount,
    referencesCount: catalog.referencesCount ?? catalog.references.length,
    mode: catalog.mode,
    status: catalog.status,
    createdAt: catalog.createdAt,
    updatedAt: catalog.updatedAt,
    catalogPath: catalog.catalogPath,
    cachePath: catalog.cachePath,
    cacheEnabled: catalog.cacheEnabled,
    cacheSize: catalog.cacheSize,
    lastSync: catalog.lastSync,
    lastOpenedAt: catalog.lastOpenedAt,
    aiStatus: catalog.aiStatus,
  };
}

export function draftToCatalog(draft: CloudEventDraft): CloudCatalog | null {
  if (!draft.id) return null;
  const now = new Date().toISOString();
  return {
    ...draft,
    id: draft.id,
    source: draft.source ?? 'cloud',
    type: draft.type ?? 'cloud',
    cacheEnabled: draft.cacheEnabled ?? true,
    cacheSize: draft.cacheSize ?? 0,
    lastSync: draft.lastSync ?? draft.updatedAt ?? now,
    createdAt: draft.createdAt ?? now,
    updatedAt: draft.updatedAt ?? now,
    eventRootFolderId: draft.eventRootFolderId,
    eventRootFolderName: draft.eventRootFolderName,
    referencesFolderIds: draft.referencesFolderIds,
    catalogPath: draft.catalogPath,
    cachePath: draft.cachePath,
    sourceBreadcrumb: draft.sourceBreadcrumb,
    totalSubfolders: draft.totalSubfolders ?? draft.subfolderCount,
    referencesCount: draft.referencesCount ?? draft.references.length,
    lastOpenedAt: draft.lastOpenedAt,
    aiStatus: draft.aiStatus,
  };
}
