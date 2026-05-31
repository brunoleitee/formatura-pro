import { API_BASE, fetchJSON, post } from './core';
import type { CatalogsResponse, CatalogSettingsResponse, CatalogFolder, CatalogFolderStats } from './types';
import { invoke } from '@tauri-apps/api/core';

export const catalogApi = {
  getCatalogs: async () => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] list_catalogs via IPC');
        return await invoke<CatalogsResponse>('list_catalogs');
      } catch (err) {
        console.error('Falha ao chamar list_catalogs via Rust, caindo para fallback HTTP:', err);
      }
    }
    return fetchJSON<CatalogsResponse>(`${API_BASE}/catalogs`);
  },
  setCatalog: async (name: string) => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] set_catalog via IPC');
        return await invoke<{ status: string; current: string }>('set_catalog', { name });
      } catch (err) {
        console.error('Falha ao chamar set_catalog via Rust, caindo para fallback HTTP:', err);
      }
    }
    return post<{ status: string; current: string }>(`${API_BASE}/catalogs/set`, { name });
  },
  renameCatalog: (old_name: string, new_name: string) => post(`${API_BASE}/catalogs/rename`, { old_name, new_name }),
  deleteCatalog: (name: string) => post(`${API_BASE}/catalogs/delete`, { name }),
  getCatalogSettings: async (catalog: string) => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] get_catalog_settings via IPC');
        return await invoke<CatalogSettingsResponse>('get_catalog_settings', { catalog });
      } catch (err) {
        console.error('Falha ao chamar get_catalog_settings via Rust, caindo para fallback HTTP:', err);
      }
    }
    return fetchJSON<CatalogSettingsResponse>(`${API_BASE}/catalogs/settings?catalog=${encodeURIComponent(catalog)}`);
  },
  saveCatalogSettings: async (catalog: string, data: { root_path?: string; scan_paths?: string[]; selected_folders?: Record<string, string> }) => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] save_catalog_settings via IPC');
        const req = {
          catalog,
          root_path: data.root_path ?? '',
          scan_paths: data.scan_paths ?? [],
          selected_folders: data.selected_folders ?? {},
        };
        return await invoke<any>('save_catalog_settings', { req });
      } catch (err) {
        console.error('Falha ao chamar save_catalog_settings via Rust, caindo para fallback HTTP:', err);
      }
    }
    return post(`${API_BASE}/catalogs/settings`, { catalog, ...data });
  },

  // Catalog Folders
  listFolders: async (catalog: string) => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] list_catalog_folders via IPC');
        return await invoke<{ folders: CatalogFolder[] }>('list_catalog_folders', { catalog });
      } catch (err) {
        console.error('Falha ao chamar list_catalog_folders via Rust, caindo para fallback HTTP:', err);
      }
    }
    return fetchJSON<{ folders: CatalogFolder[] }>(`${API_BASE}/catalogs/folders?catalog=${encodeURIComponent(catalog)}`);
  },
  getAllSubfolders: (catalog: string) =>
    fetchJSON<{ ok: boolean; subfolders: string[] }>(`${API_BASE}/catalogs/all-subfolders?catalog=${encodeURIComponent(catalog)}`),

  addFolder: async (catalog: string, path: string, includeSubfolders: boolean, scanImmediately: boolean, folderType = 'event') => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] add_catalog_folder via IPC');
        return await invoke<{ success: boolean; folderId?: number; error?: string }>('add_catalog_folder', {
          catalog,
          path,
          includeSubfolders,
          folderType,
        });
      } catch (err) {
        console.error('Falha ao chamar add_catalog_folder via Rust, caindo para fallback HTTP:', err);
      }
    }
    return post<{ success: boolean; folderId?: number; error?: string }>(`${API_BASE}/catalogs/folders`, {
      catalog, path, include_subfolders: includeSubfolders, scan_immediately: scanImmediately, folder_type: folderType,
    });
  },
  removeFolder: async (catalog: string, folderId: number) => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] remove_catalog_folder via IPC');
        return await invoke<{ success: boolean }>('remove_catalog_folder', {
          catalog,
          folderId,
        });
      } catch (err) {
        console.error('Falha ao chamar remove_catalog_folder via Rust, caindo para fallback HTTP:', err);
      }
    }
    return post<{ success: boolean }>(`${API_BASE}/catalogs/folders/remove`, { catalog, folder_id: folderId });
  },
  toggleFolder: async (catalog: string, folderId: number) => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] toggle_catalog_folder via IPC');
        return await invoke<{ success: boolean; status?: string }>('toggle_catalog_folder', {
          catalog,
          folderId,
        });
      } catch (err) {
        console.error('Falha ao chamar toggle_catalog_folder via Rust, caindo para fallback HTTP:', err);
      }
    }
    return post<{ success: boolean; status?: string }>(`${API_BASE}/catalogs/folders/toggle`, { catalog, folder_id: folderId });
  },
  getFolderStats: (catalog: string, signal?: AbortSignal) =>
    fetchJSON<CatalogFolderStats>(`${API_BASE}/catalogs/stats?catalog=${encodeURIComponent(catalog)}`, { signal }),
  scanFolder: (catalog: string, path: string, includeSubfolders: boolean) =>
    post(`${API_BASE}/catalogs/scan-folder`, { catalog, path, include_subfolders: includeSubfolders }),
  syncCatalog: (catalog: string) =>
    post<{ success: boolean; folders?: number; error?: string }>(`${API_BASE}/catalogs/sync`, { catalog }),
  unloadAiModels: async () => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] unload_ai_models via IPC');
        return await invoke<{ success: boolean }>('unload_ai_models');
      } catch (err) {
        console.error('Falha ao descarregar modelos via Rust IPC:', err);
      }
    }
    console.log('[API Base] unloadAiModels chamado (web bypass)');
    return { success: true };
  },
};
