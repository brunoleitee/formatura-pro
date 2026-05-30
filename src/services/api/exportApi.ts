import { API_BASE, fetchJSON, post } from './core';
import type { ExportStatus } from './types';
import { invoke } from '@tauri-apps/api/core';

export const exportApi = {
  checkExportConflicts: async (
    ids: string[],
    dest_path: string,
    mode: string,
    conflict_strategy: string,
    include_quality: boolean,
    include_descarte: boolean,
    organize_by_class: boolean = false,
    export_format: 'original' | 'jpg' = 'original',
  ) => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] check_export_conflicts via IPC');
        return await invoke<any>('check_export_conflicts', {
          req: {
            ids,
            dest_path,
            mode,
            conflict_strategy,
            include_quality,
            include_descarte,
            organize_by_class,
            export_format,
          }
        });
      } catch (err) {
        console.error('Falha ao chamar check_export_conflicts via Rust, caindo para fallback HTTP:', err);
      }
    }
    return post(`${API_BASE}/export/check-conflicts`, {
      ids,
      dest_path,
      mode,
      conflict_strategy,
      include_quality,
      include_descarte,
      organize_by_class,
      export_format,
    });
  },
  startExport: async (
    ids: string[],
    dest_path: string,
    mode: string,
    conflict_strategy: string,
    include_quality: boolean,
    include_descarte: boolean,
    organize_by_class: boolean = false,
    export_format: 'original' | 'jpg' = 'original',
  ) => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] start_export via IPC');
        return await invoke<any>('start_export', {
          req: {
            ids,
            dest_path,
            mode,
            conflict_strategy,
            include_quality,
            include_descarte,
            organize_by_class,
            export_format,
          }
        });
      } catch (err) {
        console.error('Falha ao chamar start_export via Rust, caindo para fallback HTTP:', err);
      }
    }
    return post(`${API_BASE}/export/start`, {
      ids,
      dest_path,
      mode,
      conflict_strategy,
      include_quality,
      include_descarte,
      organize_by_class,
      export_format,
    });
  },
  getExportStatus: async () => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] get_export_status via IPC');
        return await invoke<ExportStatus>('get_export_status');
      } catch (err) {
        console.error('Falha ao chamar get_export_status via Rust, caindo para fallback HTTP:', err);
      }
    }
    return fetchJSON<ExportStatus>(`${API_BASE}/export/status`);
  },
  clearExportSummary: async () => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] clear_export_summary via IPC');
        return await invoke<any>('clear_export_summary');
      } catch (err) {
        console.error('Falha ao chamar clear_export_summary via Rust, caindo para fallback HTTP:', err);
      }
    }
    return post(`${API_BASE}/export/clear_summary`, {});
  },
  getExportHistory: async () => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        console.log('[Tauri Rust] get_export_history via IPC');
        return await invoke<{ history: unknown[] }>('get_export_history');
      } catch (err) {
        console.error('Falha ao chamar get_export_history via Rust, caindo para fallback HTTP:', err);
      }
    }
    return fetchJSON<{ history: unknown[] }>(`${API_BASE}/export/history`);
  },
};
