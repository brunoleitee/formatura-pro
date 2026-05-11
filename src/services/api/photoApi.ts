import { API_BASE, fetchJSON, post } from './core';
import type { Photo, ScanStatus } from './types';

export const photoApi = {
  getPhotos: (path = '', catalog = '') =>
    fetchJSON<{ items?: Photo[]; photos?: Photo[] } | Photo[]>(
      `${API_BASE}/explorer/ls?path=${encodeURIComponent(path)}&catalog=${encodeURIComponent(catalog)}`
    ),
  getAllPhotos: (catalog = '', limit = 1000) =>
    fetchJSON<Photo[]>(`${API_BASE}/photos/all?catalog=${encodeURIComponent(catalog)}&limit=${limit}`),
  getPersonPhotos: (aluno_id: string) =>
    fetchJSON<Photo[]>(`${API_BASE}/photos/${encodeURIComponent(aluno_id)}`),

  // Scan
  selectFolder: () => fetchJSON<{ path: string }>(`${API_BASE}/select-folder`),
  scanFolder: (ori_path: string, ref_path = '', project_name = '') =>
    post(`${API_BASE}/scan/start`, { ori_path, ref_path, project_name }),
  getScanStatus: () => fetchJSON<ScanStatus>(`${API_BASE}/scan/status`),
  stopScan: () => post(`${API_BASE}/scan/stop`, {}),
  clearScanSummary: () => post(`${API_BASE}/scan/clear_summary`, {}),

  // Quality Audit
  startQualityAudit: (catalog = '') => post(`${API_BASE}/scan/start_quality_audit`, { catalog }),
  getQualityAuditStatus: () =>
    fetchJSON<{ is_auditing: boolean; progress: number; status_text: string; total: number; processed: number }>(
      `${API_BASE}/scan/quality_audit_status`
    ),

  // Thumbnails
  thumbUrl: (path: string, size = 300) =>
    `${API_BASE}/image_thumb?path=${encodeURIComponent(path)}&size=${size}`,
  faceThumbUrl: (path: string, x1: number, y1: number, x2: number, y2: number, size = 120) =>
    `${API_BASE}/thumb?path=${encodeURIComponent(path)}&x1=${x1}&y1=${y1}&x2=${x2}&y2=${y2}&size=${size}`,
};
