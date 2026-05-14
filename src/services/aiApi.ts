import { API_BASE, fetchJSON } from "./api/core";

export interface AIProcessResponse {
  success: boolean;
  cached?: boolean;
  face_detected: boolean;
  faces_count: number;
  embedding_ready?: boolean;
  ocr_text: string;
  ocr_confidence: number;
  ocr_confidence_pct: number;
  ocr_score: number;
  ocr_type: string;
  ocr_label: string;
  suggested_id: string | null;
  final_student: string | null;
  final_confidence: number;
  ocr_enriched: boolean;
  ai_version: string;
  error?: string;
}

export interface AIBatchStatusResponse {
  items: Array<{
    foto_path: string;
    face_detected?: boolean;
    faces_count?: number;
    ocr_text?: string;
    ocr_confidence?: number;
    embedding_ready?: boolean;
    final_student?: string | null;
    status: string;
  }>;
}

export const aiApi = {
  processPhoto: (fotoPath: string, force = false): Promise<AIProcessResponse> =>
    fetchJSON<AIProcessResponse>(
      `${API_BASE}/ai/process-photo?foto_path=${encodeURIComponent(fotoPath)}${force ? "&force=true" : ""}`,
      { method: "POST" }
    ),

  retryFaceDetection: (fotoPath: string) =>
    fetchJSON<AIProcessResponse>(
      `${API_BASE}/ai/retry-face-detection?foto_path=${encodeURIComponent(fotoPath)}`,
      { method: "POST" }
    ),

  getPhotoStatus: (fotoPath: string) =>
    fetchJSON<{ has_full: boolean; status: string; face_detected?: boolean }>(
      `${API_BASE}/ai/photo-status?foto_path=${encodeURIComponent(fotoPath)}`
    ),

  getPhotoDetails: (fotoPath: string) =>
    fetchJSON<AIProcessResponse>(
      `${API_BASE}/ai/photo-details?foto_path=${encodeURIComponent(fotoPath)}`
    ),

  batchStatus: (fotoPaths: string[]): Promise<AIBatchStatusResponse> =>
    fetchJSON<AIBatchStatusResponse>(`${API_BASE}/ai/batch-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foto_paths: fotoPaths }),
    }),
};
