const API_BASE = 'http://127.0.0.1:8000/api';

async function fetchJSON<T = unknown>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

function post<T = unknown>(url: string, body: unknown): Promise<T> {
  return fetchJSON<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// --- Types ---
export interface CatalogMeta { created_at: string; updated_at: string; }
export interface CatalogsResponse {
  current: string;
  catalogs: string[];
  catalog_meta: Record<string, CatalogMeta>;
}

export interface Person {
  id: string;
  name: string;
  total_photos: number;
  cover_path: string | null;
  cover_box: [number, number, number, number] | null;
}

export interface PhotoFace {
  aluno_id: string;
  x1: number; y1: number; x2: number; y2: number;
}

export interface Photo {
  path: string;
  name: string;
  type: string;
  size: number | null;
  mtime: number | null;
  ctime: number | null;
  faces: PhotoFace[];
  total_faces_in_db: number;
  discarded: boolean;
  blur_score: number | null;
  blur_status: string | null;
  blur_label: string | null;
  closed_eyes: boolean;
}

export interface ScanStatus {
  is_scanning: boolean;
  progress: number;
  status_text: string;
  total_processadas: number;
  total_matches: number;
  total_files: number;
  eta_seconds: number;
  device: string;
  scan_summary: unknown | null;
}

export interface ExportStatus {
  is_exporting: boolean;
  progress: number;
  status_text: string;
  total_files: number;
  processed_files: number;
  eta_seconds: number;
  export_summary: unknown | null;
}

export interface QualitySettings {
  blur_blurry_threshold: number;
  blur_attention_threshold: number;
  min_photos_per_person: number;
  manual_search_min_score: number;
}

export interface AppSettings {
  auto_backup: boolean;
  backup_interval_hours: number;
  [key: string]: unknown;
}

export interface UnknownCluster {
  cluster_id: string;
  faces: ClusterFace[];
  size: number;
}

export interface ClusterFace {
  rowid: number;
  foto_path: string;
  x1: number; y1: number; x2: number; y2: number;
  aluno_id: string;
}

export interface Stats {
  total_photos: number;
  total_people: number;
  total_occurrences: number;
  unknown_count: number;
  [key: string]: unknown;
}

export interface SearchResult { name: string; catalog: string; }

// --- API ---
export const api = {
  // Catalogs
  getCatalogs: () =>
    fetchJSON<CatalogsResponse>(`${API_BASE}/catalogs`),
  setCatalog: (name: string) =>
    post<{ status: string; current: string }>(`${API_BASE}/catalogs/set`, { name }),
  renameCatalog: (old_name: string, new_name: string) =>
    post(`${API_BASE}/catalogs/rename`, { old_name, new_name }),
  deleteCatalog: (name: string) =>
    post(`${API_BASE}/catalogs/delete`, { name }),

  // Explorer / Photos
  getPhotos: (path = '', catalog = '') =>
    fetchJSON<{ items?: Photo[]; photos?: Photo[] } | Photo[]>(
      `${API_BASE}/explorer/ls?path=${encodeURIComponent(path)}&catalog=${encodeURIComponent(catalog)}`
    ),

  // People
  getPeople: (unknown = false) =>
    fetchJSON<Person[]>(`${API_BASE}/people?unknown=${unknown}`),
  getAllPhotos: (catalog = '', limit = 1000) =>
    fetchJSON<Photo[]>(`${API_BASE}/photos/all?catalog=${encodeURIComponent(catalog)}&limit=${limit}`),
  getPersonPhotos: (aluno_id: string) =>
    fetchJSON<Photo[]>(`${API_BASE}/photos/${encodeURIComponent(aluno_id)}`),
  renamePerson: (old_id: string, new_id: string) =>
    post(`${API_BASE}/rename-person`, { old_id, new_id }),
  deletePerson: (aluno_id: string) =>
    post(`${API_BASE}/delete-person`, { aluno_id }),

  // Search
  globalSearch: (q: string) =>
    fetchJSON<SearchResult[]>(`${API_BASE}/search/global?q=${encodeURIComponent(q)}`),

  // Scan
  selectFolder: () =>
    fetchJSON<{ path: string }>(`${API_BASE}/select-folder`),
  scanFolder: (ori_path: string, ref_path = '', project_name = '') =>
    post(`${API_BASE}/scan/start`, { ori_path, ref_path, project_name }),
  getScanStatus: () =>
    fetchJSON<ScanStatus>(`${API_BASE}/scan/status`),
  stopScan: () =>
    post(`${API_BASE}/scan/stop`, {}),
  clearScanSummary: () =>
    post(`${API_BASE}/scan/clear_summary`, {}),

  // Review
  getUnknownClusters: (catalog: string, min_score = 0.58, min_cluster_size = 2, limit = 80) =>
    fetchJSON<UnknownCluster[]>(
      `${API_BASE}/unknown-clusters?catalog=${encodeURIComponent(catalog)}&min_score=${min_score}&min_cluster_size=${min_cluster_size}&limit=${limit}`
    ),
  manualIdentify: (foto_path: string, catalog: string, box: number[], new_name: string) =>
    post(`${API_BASE}/manual_identify`, { foto_path, catalog, box, new_name }),

  // Export
  checkExportConflicts: (ids: string[], dest_path: string, mode: string, conflict_strategy: string, include_quality: boolean, include_descarte: boolean) =>
    post(`${API_BASE}/export/check-conflicts`, { ids, dest_path, mode, conflict_strategy, include_quality, include_descarte }),
  startExport: (ids: string[], dest_path: string, mode: string, conflict_strategy: string, include_quality: boolean, include_descarte: boolean) =>
    post(`${API_BASE}/export/start`, { ids, dest_path, mode, conflict_strategy, include_quality, include_descarte }),
  getExportStatus: () =>
    fetchJSON<ExportStatus>(`${API_BASE}/export/status`),
  clearExportSummary: () =>
    post(`${API_BASE}/export/clear_summary`, {}),
  getExportHistory: () =>
    fetchJSON<{ history: unknown[] }>(`${API_BASE}/export/history`),

  // Settings
  getSettings: () =>
    fetchJSON<AppSettings>(`${API_BASE}/settings`),
  updateSettings: (data: Partial<AppSettings>) =>
    post<AppSettings>(`${API_BASE}/settings`, data),
  getQualitySettings: () =>
    fetchJSON<QualitySettings>(`${API_BASE}/settings/quality`),
  updateQualitySettings: (data: Partial<QualitySettings>) =>
    post<QualitySettings>(`${API_BASE}/settings/quality`, data),
  clearCache: () =>
    post(`${API_BASE}/cache/clear`, {}),

  // Stats & System
  getStats: (catalog = '') =>
    fetchJSON<Stats>(`${API_BASE}/stats?catalog=${encodeURIComponent(catalog)}`),
  getSystemStatus: () =>
    fetchJSON(`${API_BASE}/system/status`),

  // Thumbnail helpers (return URL strings)
  thumbUrl: (path: string, size = 300) =>
    `${API_BASE}/image_thumb?path=${encodeURIComponent(path)}&size=${size}`,
  faceThumbUrl: (path: string, x1: number, y1: number, x2: number, y2: number, size = 120) =>
    `${API_BASE}/thumb?path=${encodeURIComponent(path)}&x1=${x1}&y1=${y1}&x2=${x2}&y2=${y2}&size=${size}`,

  // Interaction
  openFolder: (path: string) =>
    post(`${API_BASE}/open-folder`, { path }),
};
