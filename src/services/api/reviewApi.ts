import { API_BASE, fetchJSON, post } from './core';
import type { GraduationAnalysisStatus, UnknownCluster, UnknownClustersResponse } from './types';

export const reviewApi = {
  getUnknownClusters: (catalog: string, min_score = 0.58, min_cluster_size = 2, limit = 80) =>
    fetchJSON<UnknownCluster[]>(
      `${API_BASE}/unknown-clusters?catalog=${encodeURIComponent(catalog)}&min_score=${min_score}&min_cluster_size=${min_cluster_size}&limit=${limit}`
    ),

  getUnknownClustersV2: (catalog: string, min_score = 0.58, min_cluster_size = 2, limit = 100) =>
    fetchJSON<UnknownClustersResponse>(
      `${API_BASE}/review/unknown-clusters?catalog=${encodeURIComponent(catalog)}&min_score=${min_score}&min_cluster_size=${min_cluster_size}&limit=${limit}`
    ),

  assignCluster: (
    catalog: string,
    payload: { cluster_id: string; aluno_id: string | null; nome_formando: string | null }
  ) => post(`${API_BASE}/review/unknown-clusters/assign`, { catalog, ...payload }),

  startGraduationAnalysis: (catalog: string) =>
    post<{ status: string; catalog: string }>(`${API_BASE}/review/graduation-analysis/start`, { catalog }),

  getGraduationAnalysisStatus: (catalog: string) =>
    fetchJSON<GraduationAnalysisStatus>(
      `${API_BASE}/review/graduation-analysis/status?catalog=${encodeURIComponent(catalog)}`
    ),

  manualIdentify: (foto_path: string, catalog: string, box: number[], new_name: string) =>
    post(`${API_BASE}/manual_identify`, { foto_path, catalog, box, new_name }),
};
