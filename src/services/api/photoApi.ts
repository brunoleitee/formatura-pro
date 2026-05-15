import { API_BASE, fetchJSON, post } from './core';
import type { ExplorerPhotosResponse, FolderTreeResponse, Photo, PhotoContextResponse, QualityAuditStatus, ScanStatus } from './types';

export const photoApi = {
  getPhotos: (path = '', catalog = '') =>
    fetchJSON<{ items?: Photo[]; photos?: Photo[] } | Photo[]>(
      `${API_BASE}/explorer/ls?path=${encodeURIComponent(path)}&catalog=${encodeURIComponent(catalog)}`
    ),
  getAllPhotos: (catalog = '', limit?: number) =>
    fetchJSON<Photo[]>(
      `${API_BASE}/photos/all?catalog=${encodeURIComponent(catalog)}${typeof limit === 'number' ? `&limit=${limit}` : ''}`
    ),
  getPersonPhotos: (aluno_id: string) =>
    fetchJSON<Photo[]>(`${API_BASE}/photos/${encodeURIComponent(aluno_id)}`),
  getPhotoContext: (path: string, catalog = '') =>
    fetchJSON<PhotoContextResponse>(
      `${API_BASE}/photos/context?path=${encodeURIComponent(path)}&catalog=${encodeURIComponent(catalog)}`
    ),

  // Folder Tree
  exploreTree: (path: string, max_depth = 2) =>
    fetchJSON<FolderTreeResponse>(`${API_BASE}/explorer/tree?path=${encodeURIComponent(path)}&max_depth=${max_depth}`),

  // Folder Photos
  explorePhotos: (path: string, options?: { recursive?: boolean; limit?: number; offset?: number; include_raw?: boolean; include_video?: boolean }) =>
    fetchJSON<ExplorerPhotosResponse>(
      `${API_BASE}/explorer/photos?path=${encodeURIComponent(path)}` +
      `${options?.recursive ? '&recursive=true' : ''}` +
      `${options?.limit ? `&limit=${options.limit}` : ''}` +
      `${options?.offset ? `&offset=${options.offset}` : ''}` +
      `${options?.include_raw === false ? '&include_raw=false' : ''}` +
      `${options?.include_video === false ? '&include_video=false' : ''}`
    ),

  // Scan
  selectFolder: () => fetchJSON<{ path: string }>(`${API_BASE}/select-folder`),
  scanFolder: (ori_path: string, ref_path = '', project_name = '') =>
    post(`${API_BASE}/scan/start`, { ori_path, ref_path, project_name }),
  getScanStatus: () => fetchJSON<ScanStatus>(`${API_BASE}/scan/status`),
  stopScan: () => post(`${API_BASE}/scan/stop`, {}),
  clearScanSummary: () => post(`${API_BASE}/scan/clear_summary`, {}),

  // Quality Audit
  startQualityAudit: (catalog = '') => post(`${API_BASE}/scan/quality_fill`, { catalog }),
  getQualityAuditStatus: (options?: RequestInit) =>
    fetchJSON<QualityAuditStatus>(`${API_BASE}/scan/quality_audit_status`, options),

  // Thumbnails
  thumbUrl: (path: string, size = 300, q = 80) =>
    `${API_BASE}/image_thumb?path=${encodeURIComponent(path)}&size=${size}&q=${q}`,
  previewUrl: (path: string, size = 1920) =>
    `${API_BASE}/image_preview?path=${encodeURIComponent(path)}&size=${size}`,
  fullResUrl: (path: string) =>
    `${API_BASE}/image/resized?path=${encodeURIComponent(path)}&max_size=2200`,
  faceThumbUrl: (path: string, x1: number, y1: number, x2: number, y2: number, size = 120, expand = 0, q = 80) =>
    `${API_BASE}/thumb?path=${encodeURIComponent(path)}&x1=${x1}&y1=${y1}&x2=${x2}&y2=${y2}&size=${size}${expand ? `&expand=${expand}` : ''}&q=${q}`,

  // Face identification
  bulkManualIdentify: (catalog: string, aluno_id: string, rowids: number[]) =>
    post(`${API_BASE}/faces/bulk_identify`, { catalog, aluno_id, rowids }),
  searchSimilarFaces: (face_rowid: number, catalog: string, limit = 50) =>
    fetchJSON<{ results: Array<{ rowid: number; photo_path: string; thumb_url: string; score: number; aluno_id: string | null; box?: number[]; image_width?: number; image_height?: number }> }>(
      `${API_BASE}/faces/similar?rowid=${face_rowid}&catalog=${encodeURIComponent(catalog)}&limit=${limit}`
    ),
  addManualFace: (data: { foto_path: string; catalog: string; box: number[]; new_name: string }) =>
    post(`${API_BASE}/manual_identify`, data),

  setRating: (fotoPath: string, rating: number) =>
    post<{ success: boolean; rating: number }>(
      `${API_BASE}/photo/rating?foto_path=${encodeURIComponent(fotoPath)}&rating=${rating}`, {}
    ),

  toggleFavorite: (fotoPath: string) =>
    post<{ success: boolean; favorite: boolean }>(
      `${API_BASE}/photo/favorite?foto_path=${encodeURIComponent(fotoPath)}`, {}
    ),

  getRatings: (fotoPaths: string[]) =>
    fetchJSON<{ items: Array<{ foto_path: string; rating: number; favorite: boolean }> }>(
      `${API_BASE}/photo/ratings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foto_paths: fotoPaths }),
      }
    ),
};
