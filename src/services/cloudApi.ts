import { API_BASE, fetchJSON, post } from './api/core';

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
};