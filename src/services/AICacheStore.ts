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
  private pathListeners = new Map<string, Set<Listener>>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeToPath(path: string, listener: Listener): () => void {
    if (!this.pathListeners.has(path)) this.pathListeners.set(path, new Set());
    this.pathListeners.get(path)!.add(listener);
    return () => {
      const set = this.pathListeners.get(path);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.pathListeners.delete(path);
    };
  }

  private notify(path?: string): void {
    for (const fn of this.listeners) fn();
    if (path) {
      const set = this.pathListeners.get(path);
      if (set) for (const fn of set) fn();
    }
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
    });
    this.notify(path);
  }

  updateStatus(path: string, status: AIStatus): void {
    const prev = this.cache.get(path);
    if (prev) {
      prev.status = status;
      prev.updated_at = Date.now();
      this.notify(path);
    }
  }

  delete(path: string): void {
    this.cache.delete(path);
    this.notify(path);
  }

  clear(): void {
    const paths = Array.from(this.cache.keys());
    this.cache.clear();
    for (const p of paths) this.notify(p);
    for (const fn of this.listeners) fn();
  }

  entries(): [string, AIResult][] {
    return Array.from(this.cache.entries());
  }

  get size(): number {
    return this.cache.size;
  }
}

export const aiCacheStore = new AICacheStore();
