import { API_BASE, fetchJSON, post } from './core';
import type { CatalogsResponse, CatalogSettingsResponse } from './types';

export const catalogApi = {
  getCatalogs: () => fetchJSON<CatalogsResponse>(`${API_BASE}/catalogs`),
  setCatalog: (name: string) => post<{ status: string; current: string }>(`${API_BASE}/catalogs/set`, { name }),
  renameCatalog: (old_name: string, new_name: string) => post(`${API_BASE}/catalogs/rename`, { old_name, new_name }),
  deleteCatalog: (name: string) => post(`${API_BASE}/catalogs/delete`, { name }),
  getCatalogSettings: (catalog: string) =>
    fetchJSON<CatalogSettingsResponse>(`${API_BASE}/catalogs/settings?catalog=${encodeURIComponent(catalog)}`),
  saveCatalogSettings: (catalog: string, data: { root_path?: string; scan_paths?: string[]; selected_folders?: Record<string, string> }) =>
    post(`${API_BASE}/catalogs/settings`, { catalog, ...data }),
};
