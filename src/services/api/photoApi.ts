import { API_BASE, fetchJSON, post } from './core';
import type { ExplorerPhotosResponse, FolderTreeResponse, LiveScannerStatus, Photo, PhotoContextResponse, PreviewFacesResponse, QualityAuditStatus, ScanStatus, SystemMetrics, ScannerFolderTreeResponse } from './types';

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

  getScannerFolderTree: (path: string, depth = 2) =>
    fetchJSON<ScannerFolderTreeResponse>(`${API_BASE}/scanner/folder-tree?path=${encodeURIComponent(path)}&depth=${depth}`),

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
  scanFolder: (ori_path: string, ref_path = '', project_name = '', options?: {
    face_detection_enabled?: boolean;
    selected_folders?: string[];
  }) =>
    post(`${API_BASE}/scan/start`, {
      ori_path,
      ref_path,
      project_name,
      ...(options?.face_detection_enabled !== undefined ? { face_detection_enabled: options.face_detection_enabled } : {}),
      ...(options?.selected_folders ? { selected_folders: options.selected_folders } : {}),
    }),
  getSystemMetrics: () => fetchJSON<SystemMetrics>(`${API_BASE}/system/metrics`),
  getScanStatus: () => fetchJSON<ScanStatus>(`${API_BASE}/scan/status`),
  stopScan: () => post(`${API_BASE}/scan/stop`, {}),
  scannerStop: () => post<{ success: boolean }>(`${API_BASE}/scanner/stop`, {}),
  getLiveScannerStatus: () => fetchJSON<LiveScannerStatus>(`${API_BASE}/scanner/live-status`),
  scannerCleanup: () => post<{ success: boolean }>(`${API_BASE}/scanner/cleanup`, {}),
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

  // AI Photo Details (OCR + Face data for a single photo)
  getAiPhotoDetails: (foto_path: string, catalog = '') =>
    fetchJSON<{
      processed: boolean;
      face_detected: boolean;
      possible_student: string | null;
      face_confidence: number | null;
      ocr_text: string;
      ocr_confidence: number;
      ocr_confidence_pct: number;
      ocr_type: string;
      ocr_label: string;
      suggestions: Array<{ student: string; confidence: number }>;
    }>(`${API_BASE}/ai/photo-details?foto_path=${encodeURIComponent(foto_path)}${catalog ? `&catalog=${encodeURIComponent(catalog)}` : ''}`),

  // Photo info (faces + discard status for a single photo)
  getPhotoInfo: (path: string) =>
    fetchJSON<{ faces: Array<{ box: number[]; name: string }>; discarded: boolean }>(
      `${API_BASE}/photo-info?path=${encodeURIComponent(path)}`
    ),

  // Preview faces (on-the-fly detection, no DB save)
  previewFaces: (path: string) =>
    fetchJSON<PreviewFacesResponse>(
      `${API_BASE}/scanner/preview-faces?path=${encodeURIComponent(path)}`
    ),

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
