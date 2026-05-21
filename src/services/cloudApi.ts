import { API_BASE, fetchJSON, post } from './api/core';
import type {
  CloudConnection,
  CloudCatalog,
  CloudEventDraft,
  CloudItem,
  CloudProvider,
  CloudProviderSummary,
} from '../features/cloud/types';

interface GoogleDriveStatus {
  connected: boolean;
  email?: string;
  name?: string;
  expires_at?: number;
  error?: string;
}

interface Folder {
  id: string;
  name: string;
  parent?: string;
  modifiedTime?: string;
}

interface FoldersResponse {
  folders: Folder[];
  error?: string;
}

type CloudProvidersResponse = {
  providers: CloudProviderSummary[];
};

type CloudStatusResponse = {
  connections: CloudConnection[];
  cache?: {
    folder?: string;
    usedBytes?: number;
  };
};

type CloudCatalogsResponse = {
  success: boolean;
  catalogs: CloudCatalog[];
};

const providerFallbacks: CloudProviderSummary[] = [
  { provider: 'google_drive', name: 'Google Drive', enabled: true, functional: true },
  { provider: 'dropbox', name: 'Dropbox', enabled: false, functional: false },
  { provider: 'onedrive', name: 'OneDrive', enabled: false, functional: false },
];

function providerConnection(
  provider: CloudProvider,
  connected = false,
  accountEmail?: string,
): CloudConnection {
  return {
    provider,
    connected,
    accountEmail,
    status: connected ? 'online' : 'disconnected',
  };
}

function mapFoldersToCloudItems(folders: Folder[], parentId: string): CloudItem[] {
  return folders.map(folder => ({
    id: folder.id,
    name: folder.name,
    mimeType: 'application/vnd.google-apps.folder',
    isFolder: true,
    parentId: folder.parent || parentId,
  }));
}

export const cloudApi = {
  getGoogleAuthUrl: () =>
    fetchJSON<{ auth_url: string; error?: string }>(`${API_BASE}/cloud/google/auth/start`),

  googleCallback: (code: string) =>
    post<{ status: string; email?: string; name?: string; error?: string }>(
      `${API_BASE}/cloud/google/auth/callback?code=${encodeURIComponent(code)}`,
      {}
    ),

  getGoogleStatus: () =>
    fetchJSON<GoogleDriveStatus>(`${API_BASE}/cloud/google/status`),

  googleLogout: () =>
    post<{ status: string; error?: string }>(`${API_BASE}/cloud/google/logout`, {}),

  getGoogleFolders: (parentId: string = "root") =>
    fetchJSON<FoldersResponse>(`${API_BASE}/cloud/google/folders?parent_id=${parentId}`),

  indexFolder: (folderId: string = "root") =>
    fetchJSON<{ files: unknown[]; count: number; error?: string }>(
      `${API_BASE}/cloud/google/index?folder_id=${folderId}`
    ),

  getFiles: (folderId: string = "root") =>
    fetchJSON<{ files: unknown[]; count: number; error?: string }>(
      `${API_BASE}/cloud/google/files?folder_id=${folderId}`
    ),

  getGoogleFolderSummary: (folderId: string = "root") =>
    fetchJSON<{ photos: number; subfolders: number; error?: string }>(
      `${API_BASE}/cloud/google/summary?folder_id=${folderId}`
    ),

  createCatalog: (folderId: string, catalogName: string, mode: string = "metadata_only") =>
    post<{ status: string; catalog?: string; photos_count?: number; error?: string }>(
      `${API_BASE}/cloud/google/create-catalog?folder_id=${folderId}&catalog_name=${encodeURIComponent(catalogName)}&mode=${mode}`,
      {}
    ),

  downloadFull: (fileId: string) =>
    fetchJSON<{ success: boolean; status?: string; local_path?: string; url?: string; file_id?: string; error?: string }>(
      `${API_BASE}/cloud/google/download-full?file_id=${fileId}`
    ),

  getCloudProviders: async () => {
    try {
      return await fetchJSON<CloudProvidersResponse>(`${API_BASE}/cloud/providers`);
    } catch {
      return { providers: providerFallbacks };
    }
  },

  getCloudStatus: async () => {
    try {
      return await fetchJSON<CloudStatusResponse>(`${API_BASE}/cloud/status`);
    } catch {
      const google: Partial<GoogleDriveStatus> = await cloudApi.getGoogleStatus().catch(() => ({ connected: false }));
      return {
        connections: [
          providerConnection('google_drive', Boolean(google.connected), google.email),
          providerConnection('dropbox'),
          providerConnection('onedrive'),
        ],
        cache: {
          folder: 'Cache local da nuvem',
          usedBytes: 0,
        },
      };
    }
  },

  listGoogleFolder: async (folderId: string = 'root') => {
    try {
      return await fetchJSON<{ items: CloudItem[]; error?: string }>(
        `${API_BASE}/cloud/google/list?folderId=${encodeURIComponent(folderId)}`
      );
    } catch {
      const result = await cloudApi.getGoogleFolders(folderId);
      return {
        items: mapFoldersToCloudItems(result.folders || [], folderId),
        error: result.error,
      };
    }
  },

  createCloudCatalog: async (draft: CloudEventDraft) => {
    try {
      const payload = {
        provider: draft.provider,
        folderId: draft.sourceFolderId,
        source_folder_id: draft.sourceFolderId,
        source_folder_name: draft.sourceFolderName,
        eventName: draft.name,
        name: draft.name,
        references: draft.references,
        totalFiles: draft.totalFiles,
        total_files: draft.totalFiles,
        mode: draft.mode,
      };
      console.log('[cloud-catalog] criando', payload);
      const result = await post<{ success?: boolean; catalogId: string; status: CloudEventDraft['status']; catalog?: CloudCatalog; error?: string }>(
        `${API_BASE}/cloud/catalogs`,
        payload
      );
      console.log('[cloud-catalog] criado', result);
      if (result.error || result.success === false || !result.catalogId) {
        throw new Error(result.error || 'Falha ao criar catálogo cloud');
      }
      return {
        catalog: {
          ...draft,
          id: result.catalogId,
          source: 'cloud',
          status: result.status,
          cacheEnabled: result.catalog?.cacheEnabled ?? true,
          cacheSize: result.catalog?.cacheSize ?? 0,
          lastSync: result.catalog?.lastSync,
          createdAt: result.catalog?.createdAt ?? new Date().toISOString(),
          updatedAt: result.catalog?.updatedAt ?? new Date().toISOString(),
        },
        catalogId: result.catalogId,
        status: result.status,
        error: result.error,
      };
    } catch (error: any) {
      if (error?.status !== 404) {
        throw error;
      }
      const localId = `cloud-draft-${Date.now()}`;
      const response = {
        catalog: {
          ...draft,
          id: localId,
          source: 'cloud' as const,
          provider: 'google_drive' as const,
          status: 'draft' as const,
          cacheEnabled: true,
          cacheSize: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        catalogId: localId,
        status: 'draft' as const,
        error: 'Endpoint real indisponível; fallback local temporário.',
      };
      console.log('[cloud-catalog] criado', response);
      return response;
    }
  },

  createLegacyGoogleCatalog: async (draft: CloudEventDraft) => {
      const result = await cloudApi.createCatalog(draft.sourceFolderId, draft.name);
      return {
        catalog: {
          ...draft,
          id: result.catalog || draft.id || draft.sourceFolderId,
          totalFiles: result.photos_count ?? draft.totalFiles,
          status: result.status === 'ok' ? 'indexed' : draft.status,
        },
        catalogId: result.catalog || draft.id || draft.sourceFolderId,
        status: result.status,
        error: result.error,
      };
  },

  listCloudCatalogs: async () => {
    try {
      return await fetchJSON<CloudCatalogsResponse>(`${API_BASE}/cloud/catalogs`);
    } catch {
      return { success: false, catalogs: [] };
    }
  },

  getCloudCatalog: async (catalogId: string) =>
    fetchJSON<{ success: boolean; catalog: CloudCatalog }>(
      `${API_BASE}/cloud/catalogs/${encodeURIComponent(catalogId)}`
    ),

  deleteCloudCatalog: async (catalogId: string) =>
    fetchJSON<{ success: boolean }>(
      `${API_BASE}/cloud/catalogs/${encodeURIComponent(catalogId)}`,
      { method: 'DELETE' }
    ),

  analyzeCloudCatalog: async (catalogId: string) => {
    try {
      return await post<{ status: string; error?: string }>(
        `${API_BASE}/cloud/catalogs/${encodeURIComponent(catalogId)}/analyze`,
        {}
      );
    } catch {
      return { status: 'queued' };
    }
  },
};
