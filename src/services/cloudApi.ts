import { API_BASE, fetchJSON, post } from './api/core';

export const cloudApi = {
  getAuthUrl: (provider: string) =>
    fetchJSON<{ auth_url: string }>(`${API_BASE}/cloud/${provider}/auth-url`),

  getCallback: (provider: string, code: string) =>
    post(`${API_BASE}/cloud/${provider}/callback`, { code }),

  disconnect: (provider: string) =>
    post(`${API_BASE}/cloud/${provider}/disconnect`, {}),

  listFolders: (provider: string, folderId?: string) =>
    fetchJSON<{ folders: unknown[] }>(
      `${API_BASE}/cloud/${provider}/folders${folderId ? `?parent=${folderId}` : ''}`
    ),

  getSyncStatus: () =>
    fetchJSON<{
      is_online: boolean;
      pending_uploads: number;
      pending_downloads: number;
      last_sync: string;
      sync_progress: number;
    }>(`${API_BASE}/cloud/status`),

  startSync: (folderId: string) =>
    post(`${API_BASE}/cloud/sync/start`, { folder_id: folderId }),

  getThumb: (provider: string, fileId: string, size?: number) =>
    `${API_BASE}/cloud/${provider}/thumb?file_id=${fileId}${size ? `&size=${size}` : ''}`,
};