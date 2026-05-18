import { API_BASE, fetchJSON, post } from './core';
import type {
  AssignClusterResponse,
  GraduationAnalysisStatus,
  ReviewClusterDetailResponse,
  ReviewClustersPageResponse,
  UnknownCluster,
  UnknownClustersResponse,
  StudentMatchPreviewResponse,
} from './types';

export const reviewApi = {
  getStudentMatchPreview: (catalog: string, cluster_id: string, student: string) =>
    fetchJSON<StudentMatchPreviewResponse>(
      `${API_BASE}/review/student-match-preview?catalog=${encodeURIComponent(catalog)}&cluster_id=${encodeURIComponent(cluster_id)}&student=${encodeURIComponent(student)}`
    ),

  getUnknownClusters: (catalog: string, min_score = 0.58, min_cluster_size = 2, limit = 80) =>
    fetchJSON<UnknownCluster[]>(
      `${API_BASE}/unknown-clusters?catalog=${encodeURIComponent(catalog)}&min_score=${min_score}&min_cluster_size=${min_cluster_size}&limit=${limit}`
    ),

  getUnknownClustersV2: (catalog: string, min_score = 0.58, min_cluster_size = 2, limit = 100) =>
    fetchJSON<UnknownClustersResponse>(
      `${API_BASE}/review/unknown-clusters?catalog=${encodeURIComponent(catalog)}&min_score=${min_score}&min_cluster_size=${min_cluster_size}&limit=${limit}`
    ),

  getReviewClusters: (catalog: string, limit = 30, offset = 0) =>
    fetchJSON<ReviewClustersPageResponse>(
      `${API_BASE}/review/clusters?catalog=${encodeURIComponent(catalog)}&limit=${limit}&offset=${offset}&_t=${Date.now()}`
    ),

  getReviewClusterDetail: (catalog: string, clusterId: string) =>
    fetchJSON<ReviewClusterDetailResponse>(
      `${API_BASE}/review/clusters/detail?catalog=${encodeURIComponent(catalog)}&cluster_id=${encodeURIComponent(clusterId)}`
    ),

  assignCluster: (
    catalog: string,
    payload: { cluster_id: string; aluno_id: string | null; nome_formando: string | null }
  ) => post<AssignClusterResponse>(`${API_BASE}/review/unknown-clusters/assign`, { catalog, ...payload }),

  ignoreCluster: async (catalog: string, cluster_id: string, rowids: number[] = []) => {
    const payload = { catalog, cluster_id, rowids };
    const routes = [
      `${API_BASE}/review/unknown-clusters/ignore`,
      `${API_BASE}/review/ignore`,
      `${API_BASE}/unknown-clusters/ignore`,
      `${API_BASE}/review/cluster/ignore`,
      `${API_BASE}/review/bulk-ignore`,
    ];

    let lastError: unknown = null;
    for (const route of routes) {
      try {
        return await post<{ ok: boolean; success: boolean; cluster_id: string; status: string; ignored?: number }>(route, payload);
      } catch (error) {
        lastError = error;
        const status = (error as { status?: number } | null)?.status;
        if (status && status !== 404) throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Falha ao ignorar grupo.');
  },

  startGraduationAnalysis: (catalog: string) =>
    post<{ status: string; catalog: string }>(`${API_BASE}/review/graduation-analysis/start`, { catalog }),

  getGraduationAnalysisStatus: (catalog: string) =>
    fetchJSON<GraduationAnalysisStatus>(
      `${API_BASE}/review/graduation-analysis/status?catalog=${encodeURIComponent(catalog)}`
    ),

  manualIdentify: (foto_path: string, catalog: string, box: number[], new_name: string) =>
    post(`${API_BASE}/manual_identify`, { foto_path, catalog, box, new_name }),

  mergeCluster: (catalog: string, sourceClusterId: string, targetClusterId: string) =>
    post<{ ok: boolean; source: string; target: string }>(
      `${API_BASE}/review/clusters/merge?catalog=${encodeURIComponent(catalog)}&source_cluster_id=${encodeURIComponent(sourceClusterId)}&target_cluster_id=${encodeURIComponent(targetClusterId)}`, {}
    ),

  graduationManualOverride: (
    catalog: string,
    payload: { rowids: number[]; action: 'confirm' | 'remove'; item: 'gown' | 'diploma' | 'sash' | 'cap' }
  ) => post<{ ok: boolean; updated: number; item: string; action: string }>(
    `${API_BASE}/review/graduation/manual-override`,
    { catalog, ...payload }
  ),

  discardPhoto: (payload: { foto_path: string; discard: boolean }) =>
    post(`${API_BASE}/discard-photo`, payload),

  bulkDiscardPhotos: (catalog: string, foto_paths: string[]) =>
    post(`${API_BASE}/review/bulk-discard`, { catalog, foto_paths }),

  bulkRestorePhotos: (catalog: string, foto_paths: string[]) =>
    post(`${API_BASE}/review/bulk-restore`, { catalog, foto_paths }),

  bulkManualIdentify: (catalog: string, new_name: string, rowids: number[]) =>
    post(`${API_BASE}/review/bulk-manual-identify`, { catalog, new_name, rowids }),

  generateAllEmbeddings: (catalog: string) =>
    post<{ ok: boolean; stats?: Record<string, number> }>(`${API_BASE}/review/generate-all-embeddings`, { catalog }),
};
