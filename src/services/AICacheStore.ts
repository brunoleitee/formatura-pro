export type AIStatus = "idle" | "pending" | "processing" | "completed" | "error";

export interface AIResult {
  path: string;
  face_detected: boolean;
  faces_count: number;
  embedding_ready: boolean;
  ocr_text: string;
  ocr_confidence: number;
  ocr_confidence_pct: number;
  ocr_type: string;
  ocr_label: string;
  suggested_id: string | null;
  final_student: string | null;
  final_confidence: number;
  ocr_enriched: boolean;
  ai_version: string;
  status: AIStatus;
  updated_at: number;
}

type Listener = () => void;

class AICacheStore {
  private cache = new Map<string, AIResult>();
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  get(path: string): AIResult | undefined {
    return this.cache.get(path);
  }

  has(path: string): boolean {
    return this.cache.has(path);
  }

  set(path: string, result: Partial<AIResult>): void {
    const prev = this.cache.get(path);
    this.cache.set(path, {
      path,
      face_detected: false,
      faces_count: 0,
      embedding_ready: false,
      ocr_text: "",
      ocr_confidence: 0,
      ocr_confidence_pct: 0,
      ocr_type: "none",
      ocr_label: "OCR geral",
      suggested_id: null,
      final_student: null,
      final_confidence: 0,
      ocr_enriched: false,
      ai_version: "",
      status: "idle",
      updated_at: Date.now(),
      ...prev,
      ...result,
      path,
    });
    this.notify();
  }

  updateStatus(path: string, status: AIStatus): void {
    const prev = this.cache.get(path);
    if (prev) {
      prev.status = status;
      prev.updated_at = Date.now();
      this.notify();
    }
  }

  delete(path: string): void {
    this.cache.delete(path);
    this.notify();
  }

  clear(): void {
    this.cache.clear();
    this.notify();
  }

  entries(): [string, AIResult][] {
    return Array.from(this.cache.entries());
  }

  get size(): number {
    return this.cache.size;
  }
}

export const aiCacheStore = new AICacheStore();
