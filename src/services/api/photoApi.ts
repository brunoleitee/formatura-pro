import { API_BASE, fetchJSON, post } from './core';
import type { ExplorerPhotosResponse, FolderTreeResponse, LiveScannerStatus, Photo, PhotoContextResponse, PhotosPageResponse, PreviewFacesResponse, QualityAuditStatus, ScanStatus, SystemMetrics, ScannerFolderTreeResponse } from './types';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';

const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

const getThumbBase = () => {
  if (typeof window !== 'undefined' && navigator.userAgent.includes('Windows')) {
    return 'http://thumb.localhost';
  }
  return 'thumb://localhost';
};

const RAW_EXTENSIONS = ['.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.dng', '.raf', '.srw', '.x3f'];

export const photoApi = {
  getPhotos: async (path = '', catalog = '', signal?: AbortSignal) => {
    if (isTauri) {
      try {
        console.log('[Tauri Rust] explorer_ls via IPC');
        const res = await invoke<any>('explorer_ls', { path, catalog });
        return res;
      } catch (err) {
        console.error('Falha ao chamar explorer_ls via Rust, caindo para fallback HTTP:', err);
      }
    }
    return fetchJSON<{ items?: Photo[]; photos?: Photo[] } | Photo[]>(
      `${API_BASE}/explorer/ls?path=${encodeURIComponent(path)}&catalog=${encodeURIComponent(catalog)}`,
      { signal }
    );
  },
  getAllPhotos: (catalog = '', limit?: number, signal?: AbortSignal) => {
    console.warn(`[legacy-api] /api/photos/all chamado por ${new Error().stack?.split('\n')[2]?.trim() || 'desconhecido'}`);
    return fetchJSON<Photo[]>(
      `${API_BASE}/photos/all?catalog=${encodeURIComponent(catalog)}${typeof limit === 'number' ? `&limit=${limit}` : ''}`,
      { signal }
    );
  },
  getPhotosPage: (catalog: string, limit = 100, offset = 0, subfolder?: string | null, signal?: AbortSignal) =>
    fetchJSON<PhotosPageResponse>(
      `${API_BASE}/photos?catalog=${encodeURIComponent(catalog)}&limit=${limit}&offset=${offset}` +
      `${subfolder ? `&subfolder=${encodeURIComponent(subfolder)}` : ''}`,
      { signal }
    ),
  getPersonPhotos: (aluno_id: string, catalog: string = '', signal?: AbortSignal) =>
    fetchJSON<Photo[]>(`${API_BASE}/photos/${encodeURIComponent(aluno_id)}?catalog=${encodeURIComponent(catalog)}`, { signal }),
  getPhotoContext: (path: string, catalog = '', signal?: AbortSignal) =>
    fetchJSON<PhotoContextResponse>(
      `${API_BASE}/photos/context?path=${encodeURIComponent(path)}&catalog=${encodeURIComponent(catalog)}`,
      { signal }
    ),

  // Folder Tree
  exploreTree: async (path: string, max_depth = 2) => {
    if (isTauri) {
      try {
        console.log('[Tauri Rust] explorer_tree via IPC');
        return await invoke<FolderTreeResponse>('explorer_tree', { path, maxDepth: max_depth });
      } catch (err) {
        console.error('Falha ao chamar explorer_tree via Rust, caindo para fallback HTTP:', err);
      }
    }
    return fetchJSON<FolderTreeResponse>(`${API_BASE}/explorer/tree?path=${encodeURIComponent(path)}&max_depth=${max_depth}`);
  },

  getScannerFolderTree: async (path: string, depth = 2) => {
    if (isTauri) {
      try {
        console.log('[Tauri Rust] getScannerFolderTree via IPC');
        return await invoke<ScannerFolderTreeResponse>('explorer_tree', { path, maxDepth: depth });
      } catch (err) {
        console.error('Falha ao chamar explorer_tree via Rust, caindo para fallback HTTP:', err);
      }
    }
    return fetchJSON<ScannerFolderTreeResponse>(`${API_BASE}/scanner/folder-tree?path=${encodeURIComponent(path)}&depth=${depth}`);
  },

  // Folder Photos
  explorePhotos: async (path: string, options?: { recursive?: boolean; limit?: number; offset?: number; include_raw?: boolean; include_video?: boolean }) => {
    if (isTauri) {
      try {
        console.log('[Tauri Rust] explorer_photos via IPC');
        return await invoke<ExplorerPhotosResponse>('explorer_photos', {
          path,
          recursive: !!options?.recursive,
          limit: options?.limit ?? 0,
          offset: options?.offset ?? 0,
          includeRaw: options?.include_raw !== false,
          includeVideo: options?.include_video !== false,
        });
      } catch (err) {
        console.error('Falha ao chamar explorer_photos via Rust, caindo para fallback HTTP:', err);
      }
    }
    return fetchJSON<ExplorerPhotosResponse>(
      `${API_BASE}/explorer/photos?path=${encodeURIComponent(path)}` +
      `${options?.recursive ? '&recursive=true' : ''}` +
      `${options?.limit ? `&limit=${options.limit}` : ''}` +
      `${options?.offset ? `&offset=${options.offset}` : ''}` +
      `${options?.include_raw === false ? '&include_raw=false' : ''}` +
      `${options?.include_video === false ? '&include_video=false' : ''}`
    );
  },

  // Scan
  selectFolder: () => fetchJSON<{ path: string }>(`${API_BASE}/select-folder`),
  selectFile: () => fetchJSON<{ path: string }>(`${API_BASE}/select-file`),
  scanFolder: (event_path: string, ref_path = '', project_name = '', options?: {
    selected_folders?: string[];
  }) =>
    post(`${API_BASE}/scan/start`, {
      event_path,
      ref_path,
      project_name,
      ...(options?.selected_folders ? { selected_folders: options.selected_folders } : {}),
    }),
  getSystemMetrics: () => fetchJSON<SystemMetrics>(`${API_BASE}/system/metrics`),
  getScanStatus: (signal?: AbortSignal) => fetchJSON<ScanStatus>(`${API_BASE}/scan/status`, { signal }),
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
  thumbUrl: (path: string, size = 300, q = 80) => {
    const isRaw = RAW_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext));
    if (isTauri && !isRaw) {
      return `${getThumbBase()}/?path=${encodeURIComponent(path)}&size=${size}&q=${q}`;
    }
    return `${API_BASE}/image_thumb?path=${encodeURIComponent(path)}&size=${size}&q=${q}`;
  },
  previewUrl: (path: string, size = 1200) => {
    const isRaw = RAW_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext));
    if (isTauri && !isRaw) {
      return `${getThumbBase()}/?path=${encodeURIComponent(path)}&size=${size}`;
    }
    return `${API_BASE}/image_preview?path=${encodeURIComponent(path)}&size=${size}`;
  },
  fullResUrl: (path: string) =>
    `${API_BASE}/image/resized?path=${encodeURIComponent(path)}&max_size=2200`,
  faceThumbUrl: (path: string, x1: number, y1: number, x2: number, y2: number, size = 120, expand = 0, q = 80) => {
    const isRaw = RAW_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext));
    if (isTauri && !isRaw) {
      return `${getThumbBase()}/face?path=${encodeURIComponent(path)}&x1=${x1}&y1=${y1}&x2=${x2}&y2=${y2}&size=${size}${expand ? `&expand=${expand}` : ''}&q=${q}`;
    }
    return `${API_BASE}/thumb?path=${encodeURIComponent(path)}&x1=${x1}&y1=${y1}&x2=${x2}&y2=${y2}&size=${size}${expand ? `&expand=${expand}` : ''}&q=${q}`;
  },

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
  getPhotoInfo: async (path: string) => {
    if (isTauri) {
      try {
        console.log('[Tauri Rust] get_photo_info via IPC');
        return await invoke<{ faces: Array<{ box: number[]; name: string }>; discarded: boolean }>('get_photo_info', { path, catalog: '' });
      } catch (err) {
        console.error('Falha ao chamar get_photo_info via Rust, caindo para fallback HTTP:', err);
      }
    }
    return fetchJSON<{ faces: Array<{ box: number[]; name: string }>; discarded: boolean }>(
      `${API_BASE}/photo-info?path=${encodeURIComponent(path)}`
    );
  },

  // Preview faces (on-the-fly detection, no DB save)
  previewFaces: async (path: string) => {
    if (isTauri) {
      try {
        console.log('[Tauri Rust] preview_faces_native via IPC');
        return await invoke<PreviewFacesResponse>('preview_faces_native', { path });
      } catch (err) {
        console.error('Falha ao chamar preview_faces_native via Rust, caindo para fallback HTTP:', err);
      }
    }
    return fetchJSON<PreviewFacesResponse>(
      `${API_BASE}/scanner/preview-faces?path=${encodeURIComponent(path)}`
    );
  },

  // Face identification
  bulkManualIdentify: (catalog: string, aluno_id: string, rowids: number[]) =>
    post(`${API_BASE}/faces/bulk_identify`, { catalog, aluno_id, rowids }),
  searchSimilarFaces: (face_rowid: number, catalog: string, limit = 50) =>
    fetchJSON<{ results: Array<{ rowid: number; photo_path: string; thumb_url: string; score: number; aluno_id: string | null; box?: number[]; image_width?: number; image_height?: number }> }>(
      `${API_BASE}/faces/similar?rowid=${face_rowid}&catalog=${encodeURIComponent(catalog)}&limit=${limit}`
    ),
  addManualFace: (data: { foto_path: string; catalog: string; box: number[]; new_name: string }) =>
    post(`${API_BASE}/manual_identify`, data),

  setRating: async (fotoPath: string, rating: number) => {
    if (isTauri) {
      try {
        console.log('[Tauri Rust] set_photo_rating via IPC');
        return await invoke<{ success: boolean; rating: number }>('set_photo_rating', { fotoPath, rating, catalog: '' });
      } catch (err) {
        console.error('Falha ao chamar set_photo_rating via Rust, caindo para fallback HTTP:', err);
      }
    }
    return post<{ success: boolean; rating: number }>(
      `${API_BASE}/photo/rating?foto_path=${encodeURIComponent(fotoPath)}&rating=${rating}`, {}
    );
  },

  toggleFavorite: async (fotoPath: string) => {
    if (isTauri) {
      try {
        console.log('[Tauri Rust] toggle_photo_favorite via IPC');
        return await invoke<{ success: boolean; favorite: boolean }>('toggle_photo_favorite', { fotoPath, catalog: '' });
      } catch (err) {
        console.error('Falha ao chamar toggle_photo_favorite via Rust, caindo para fallback HTTP:', err);
      }
    }
    return post<{ success: boolean; favorite: boolean }>(
      `${API_BASE}/photo/favorite?foto_path=${encodeURIComponent(fotoPath)}`, {}
    );
  },

  getRatings: async (fotoPaths: string[]) => {
    if (isTauri) {
      try {
        console.log('[Tauri Rust] get_photos_ratings via IPC');
        return await invoke<{ items: Array<{ foto_path: string; rating: number; favorite: boolean }> }>('get_photos_ratings', { fotoPaths, catalog: '' });
      } catch (err) {
        console.error('Falha ao chamar get_photos_ratings via Rust, caindo para fallback HTTP:', err);
      }
    }
    return fetchJSON<{ items: Array<{ foto_path: string; rating: number; favorite: boolean }> }>(
      `${API_BASE}/photo/ratings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foto_paths: fotoPaths }),
      }
    );
  },
};
