import { API_BASE, fetchJSON, post } from './core';
import type { ExportStatus } from './types';

export const exportApi = {
  checkExportConflicts: (
    ids: string[],
    dest_path: string,
    mode: string,
    conflict_strategy: string,
    include_quality: boolean,
    include_descarte: boolean,
    organize_by_class: boolean = false,
    export_format: 'original' | 'jpg' = 'original',
  ) =>
    post(`${API_BASE}/export/check-conflicts`, {
      ids,
      dest_path,
      mode,
      conflict_strategy,
      include_quality,
      include_descarte,
      organize_by_class,
      export_format,
    }),
  startExport: (
    ids: string[],
    dest_path: string,
    mode: string,
    conflict_strategy: string,
    include_quality: boolean,
    include_descarte: boolean,
    organize_by_class: boolean = false,
    export_format: 'original' | 'jpg' = 'original',
  ) =>
    post(`${API_BASE}/export/start`, {
      ids,
      dest_path,
      mode,
      conflict_strategy,
      include_quality,
      include_descarte,
      organize_by_class,
      export_format,
    }),
  getExportStatus: () => fetchJSON<ExportStatus>(`${API_BASE}/export/status`),
  clearExportSummary: () => post(`${API_BASE}/export/clear_summary`, {}),
  getExportHistory: () => fetchJSON<{ history: unknown[] }>(`${API_BASE}/export/history`),
};
