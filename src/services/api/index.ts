import { catalogApi } from './catalogApi';
import { photoApi } from './photoApi';
import { peopleApi } from './peopleApi';
import { reviewApi } from './reviewApi';
import { exportApi } from './exportApi';
import { fetchJSON, post, API_BASE } from './core';
import type { AppSettings, QualitySettings, Stats, Photo } from './types';

export type { Photo };

// The combined api object matching the previous shape
export const api = {
  ...catalogApi,
  ...photoApi,
  ...peopleApi,
  ...reviewApi,
  ...exportApi,

  // Settings
  getSettings: () => fetchJSON<AppSettings>(`${API_BASE}/settings`),
  updateSettings: (data: Partial<AppSettings>) => post<AppSettings>(`${API_BASE}/settings`, data),
  getQualitySettings: () => fetchJSON<QualitySettings>(`${API_BASE}/settings/quality`),
  updateQualitySettings: (data: Partial<QualitySettings>) => post<QualitySettings>(`${API_BASE}/settings/quality`, data),
  clearCache: () => post(`${API_BASE}/cache/clear`, {}),

  // Stats & System
  getStats: (catalog = '') => fetchJSON<Stats>(`${API_BASE}/stats?catalog=${encodeURIComponent(catalog)}`),
  getSystemStatus: () => fetchJSON(`${API_BASE}/system/status`),

  // Interaction
  openFolder: (path: string) => post(`${API_BASE}/open-folder`, { path }),
};

export * from './types';
