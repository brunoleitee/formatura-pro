interface CacheEntry {
  image: HTMLImageElement;
  loaded: boolean;
  timestamp: number;
  width: number;
  height: number;
}

const MAX_ENTRIES = 200;
const MAX_CONCURRENT = 5;
const log = (msg: string) => {
  if (typeof window !== 'undefined' && window.localStorage?.getItem('formaturapro:perf') === '1') {
    console.debug(`[IMAGE-CACHE] ${msg}`);
  }
};

class ImagePreloadCache {
  private cache = new Map<string, CacheEntry>();
  private queue: Array<{ path: string; url: string; resolve: (ok: boolean) => void }> = [];
  private active = 0;
  private cancelled = new Set<string>();

  private touch(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      entry.timestamp = Date.now();
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
  }

  private evict(): void {
    while (this.cache.size > MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) {
        this.cache.delete(oldest);
        log(`cache evicted: ${oldest}`);
      }
    }
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (this.cancelled.has(job.path)) {
        this.cancelled.delete(job.path);
        continue;
      }
      this.active++;
      const img = new window.Image();
      img.decoding = "async";
      img.onload = () => {
        img.decode().then(() => {
          this.active--;
          this.cache.set(job.path, {
            image: img,
            loaded: true,
            timestamp: Date.now(),
            width: img.naturalWidth,
            height: img.naturalHeight,
          });
          this.evict();
          job.resolve(true);
          log(`preload concluido: ${job.path}`);
          this.pump();
        }).catch(() => {
          this.active--;
          job.resolve(false);
          this.pump();
        });
      };
      img.onerror = () => {
        this.active--;
        this.cache.set(job.path, {
          image: img,
          loaded: false,
          timestamp: Date.now(),
          width: 0,
          height: 0,
        });
        job.resolve(false);
        log(`preload falhou: ${job.path}`);
        this.pump();
      };
      img.src = job.url;
      log(`preload iniciado: ${job.path}`);
    }
  }

  preload(path: string, url: string): Promise<boolean> {
    const existing = this.cache.get(path);
    if (existing?.loaded) {
      this.touch(path);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      this.queue.push({ path, url, resolve });
      this.pump();
    });
  }

  getCached(path: string): { image: HTMLImageElement; width: number; height: number } | null {
    const entry = this.cache.get(path);
    if (entry?.loaded) {
      this.touch(path);
      return { image: entry.image, width: entry.width, height: entry.height };
    }
    return null;
  }

  has(path: string): boolean {
    return this.cache.get(path)?.loaded === true;
  }

  cancel(path: string): void {
    this.cancelled.add(path);
    this.queue = this.queue.filter((j) => j.path !== path);
  }

  cancelAll(): void {
    for (const job of this.queue) {
      this.cancelled.add(job.path);
    }
    this.queue = [];
  }

  get size(): number {
    return this.cache.size;
  }

  get pending(): number {
    return this.queue.length;
  }
}

export const imagePreloadCache = new ImagePreloadCache();
