import { aiCacheStore } from "./AICacheStore";
import { aiApi } from "./aiApi";

interface QueueItem {
  path: string;
  priority: number;
  addedAt: number;
}

const MAX_CONCURRENT = 1;
const MAX_QUEUE_SIZE = 20;
const DEBOUNCE_MS = 300;

class AIQueueManager {
  private queue: QueueItem[] = [];
  private processing = new Set<string>();
  private processed = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBatch = new Set<string>();
  private running = false;

  private log(msg: string): void {
    console.log(`[AI-QUEUE] ${msg}`);
  }

  add(path: string, priority = 0): void {
    if (this.processed.has(path)) return;
    if (this.processing.has(path)) return;
    if (this.queue.length + this.pendingBatch.size >= MAX_QUEUE_SIZE) return;
    if (aiCacheStore.has(path)) {
      const cached = aiCacheStore.get(path)!;
      if (cached.status === "completed") return;
      if (cached.status === "error") {
        const age = Date.now() - cached.updated_at;
        if (age < 60000) return;
      }
    }
    this.pendingBatch.add(path);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushBatch(), DEBOUNCE_MS);
  }

  batchInitialize(paths: string[]): void {
    const pending: string[] = [];
    for (const p of paths) {
      if (this.processed.has(p) || this.processing.has(p)) continue;
      if (this.queue.length + pending.length >= MAX_QUEUE_SIZE) break;
      if (aiCacheStore.has(p)) {
        const cached = aiCacheStore.get(p)!;
        if (cached.status === "completed") continue;
      }
      pending.push(p);
    }
    if (pending.length === 0) return;
    this.log(`batch inicializando: ${pending.length} fotos pendentes`);
    for (const p of pending) {
      this.pendingBatch.add(p);
    }
    this.flushBatch();
  }

  private flushBatch(): void {
    for (const path of this.pendingBatch) {
      const exists = this.queue.find((q) => q.path === path);
      if (!exists) {
        this.queue.push({ path, priority: 0, addedAt: Date.now() });
        this.log(`adicionada: ${path}`);
      }
    }
    this.pendingBatch.clear();
    this.sortQueue();
    this.processNext();
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);
  }

  private processNext(): void {
    if (!this.running) this.running = true;
    while (this.processing.size < MAX_CONCURRENT && this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (this.processed.has(item.path)) continue;
      this.processing.add(item.path);
      aiCacheStore.set(item.path, { status: "pending" });
      this.execute(item.path);
    }
    if (this.processing.size === 0 && this.queue.length === 0) {
      this.running = false;
    }
  }

  private async execute(path: string): Promise<void> {
    this.log(`iniciando processamento: ${path}`);
    aiCacheStore.updateStatus(path, "processing");
    try {
      const result = await aiApi.processPhoto(path);
      if (result.cached) {
        this.log(`usando cache: ${path}`);
      } else {
        this.log(`concluida: ${path}`);
      }
      aiCacheStore.set(path, {
        face_detected: result.face_detected,
        faces_count: result.faces_count,
        embedding_ready: result.embedding_ready ?? false,
        ocr_text: result.ocr_text || "",
        ocr_confidence: result.ocr_confidence || 0,
        ocr_confidence_pct: result.ocr_confidence_pct || 0,
        ocr_type: result.ocr_type || "none",
        ocr_label: result.ocr_label || "OCR geral",
        suggested_id: result.suggested_id || null,
        final_student: result.final_student || null,
        final_confidence: result.final_confidence || 0,
        ocr_enriched: result.ocr_enriched || false,
        ai_version: result.ai_version || "",
        status: "completed",
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`erro: ${path} - ${msg}`);
      aiCacheStore.set(path, { status: "error" });
    } finally {
      this.processing.delete(path);
      this.processed.add(path);
      this.processNext();
    }
  }

  cancel(path: string): void {
    this.queue = this.queue.filter((q) => q.path !== path);
    this.pendingBatch.delete(path);
    if (this.processing.has(path)) {
      this.log(`cancelada (ja em processamento): ${path}`);
    }
  }

  cancelAll(): void {
    const inFlight = Array.from(this.processing);
    this.log(`cancelando ${this.queue.length + inFlight.length} itens`);
    this.queue = [];
    this.pendingBatch.clear();
  }

  setPriority(path: string, priority: number): void {
    const item = this.queue.find((q) => q.path === path);
    if (item) item.priority = priority;
    this.sortQueue();
  }

  isProcessing(path: string): boolean {
    return this.processing.has(path);
  }

  isQueued(path: string): boolean {
    return this.queue.some((q) => q.path === path);
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getProcessingCount(): number {
    return this.processing.size;
  }
}

export const aiQueueManager = new AIQueueManager();
