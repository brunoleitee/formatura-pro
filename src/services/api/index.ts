import { catalogApi } from './catalogApi';
import { photoApi } from './photoApi';
import { peopleApi } from './peopleApi';
import { reviewApi } from './reviewApi';
import { exportApi } from './exportApi';
import { fetchJSON, post, API_BASE } from './core';
import type { AppSettings, QualitySettings, Stats, Photo } from './types';

export type { Photo };
export { catalogApi };

// The combined api object matching the previous shape
export const api = {
  ...catalogApi,
  ...photoApi,
  ...peopleApi,
  ...reviewApi,
  ...exportApi,

  // Settings
  getSettings: (signal?: AbortSignal) => fetchJSON<AppSettings>(`${API_BASE}/settings`, { signal }),
  updateSettings: (data: Partial<AppSettings>) => post<AppSettings>(`${API_BASE}/settings`, data),
  getQualitySettings: (signal?: AbortSignal) => fetchJSON<QualitySettings>(`${API_BASE}/settings/quality`, { signal }),
  updateQualitySettings: (data: Partial<QualitySettings>) => post<QualitySettings>(`${API_BASE}/settings/quality`, data),
  clearCache: () => post(`${API_BASE}/cache/clear`, {}),

  // Stats & System
  getStats: (catalog = '', signal?: AbortSignal) => fetchJSON<Stats>(`${API_BASE}/stats?catalog=${encodeURIComponent(catalog)}`, { signal }),
  getSystemStatus: (signal?: AbortSignal) => fetchJSON(`${API_BASE}/system/status`, { signal }),

  // Interaction
  openFolder: (path: string) => post(`${API_BASE}/open-folder`, { path }),
  openPhotoshop: (path: string) => post(`${API_BASE}/open-photoshop`, { path }),
  openFile: (path: string) => post(`${API_BASE}/open-file`, { path }),
  openSystemPath: (path: string) => post(`${API_BASE}/system/open-path`, { path }),
};

export * from './types';
