import { API_BASE, fetchJSON, post } from './core';
import type { UnknownCluster } from './types';

export const reviewApi = {
  getUnknownClusters: (catalog: string, min_score = 0.58, min_cluster_size = 2, limit = 80) =>
    fetchJSON<UnknownCluster[]>(
      `${API_BASE}/unknown-clusters?catalog=${encodeURIComponent(catalog)}&min_score=${min_score}&min_cluster_size=${min_cluster_size}&limit=${limit}`
    ),
  manualIdentify: (foto_path: string, catalog: string, box: number[], new_name: string) =>
    post(`${API_BASE}/manual_identify`, { foto_path, catalog, box, new_name }),
};
