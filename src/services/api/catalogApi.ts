import { API_BASE, fetchJSON, post } from './core';
import type { CatalogsResponse } from './types';

export const catalogApi = {
  getCatalogs: () => fetchJSON<CatalogsResponse>(`${API_BASE}/catalogs`),
  setCatalog: (name: string) => post<{ status: string; current: string }>(`${API_BASE}/catalogs/set`, { name }),
  renameCatalog: (old_name: string, new_name: string) => post(`${API_BASE}/catalogs/rename`, { old_name, new_name }),
  deleteCatalog: (name: string) => post(`${API_BASE}/catalogs/delete`, { name }),
};
