import { API_BASE, fetchJSON, post } from './core';
import type { CatalogsResponse, CatalogSettingsResponse, CatalogFolder, CatalogFolderStats } from './types';

export const catalogApi = {
  getCatalogs: () => fetchJSON<CatalogsResponse>(`${API_BASE}/catalogs`),
  setCatalog: (name: string) => post<{ status: string; current: string }>(`${API_BASE}/catalogs/set`, { name }),
  renameCatalog: (old_name: string, new_name: string) => post(`${API_BASE}/catalogs/rename`, { old_name, new_name }),
  deleteCatalog: (name: string) => post(`${API_BASE}/catalogs/delete`, { name }),
  getCatalogSettings: (catalog: string) =>
    fetchJSON<CatalogSettingsResponse>(`${API_BASE}/catalogs/settings?catalog=${encodeURIComponent(catalog)}`),
  saveCatalogSettings: (catalog: string, data: { root_path?: string; scan_paths?: string[]; selected_folders?: Record<string, string> }) =>
    post(`${API_BASE}/catalogs/settings`, { catalog, ...data }),

  // Catalog Folders
  listFolders: (catalog: string) =>
    fetchJSON<CatalogFolder[]>(`${API_BASE}/catalogs/folders?catalog=${encodeURIComponent(catalog)}`),
  addFolder: (catalog: string, path: string, includeSubfolders: boolean, scanImmediately: boolean, folderType = 'event') =>
    post<{ success: boolean; folderId?: number; error?: string }>(`${API_BASE}/catalogs/folders`, {
      catalog, path, include_subfolders: includeSubfolders, scan_immediately: scanImmediately, folder_type: folderType,
    }),
  removeFolder: (catalog: string, folderId: number) =>
    post<{ success: boolean }>(`${API_BASE}/catalogs/folders/remove`, { catalog, folder_id: folderId }),
  toggleFolder: (catalog: string, folderId: number) =>
    post<{ success: boolean; status?: string }>(`${API_BASE}/catalogs/folders/toggle`, { catalog, folder_id: folderId }),
  getFolderStats: (catalog: string) =>
    fetchJSON<CatalogFolderStats>(`${API_BASE}/catalogs/stats?catalog=${encodeURIComponent(catalog)}`),
  scanFolder: (catalog: string, path: string, includeSubfolders: boolean) =>
    post(`${API_BASE}/catalogs/scan-folder`, { catalog, path, include_subfolders: includeSubfolders }),
  syncCatalog: (catalog: string) =>
    post<{ success: boolean; folders?: number; error?: string }>(`${API_BASE}/catalogs/sync`, { catalog }),
};
