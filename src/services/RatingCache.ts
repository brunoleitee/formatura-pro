export interface PhotoMeta {
  rating: number;
  favorite: boolean;
}

type Listener = () => void;

class RatingCache {
  private cache = new Map<string, PhotoMeta>();
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

  get(path: string): PhotoMeta {
    return this.cache.get(path) ?? { rating: 0, favorite: false };
  }

  setRating(path: string, rating: number): void {
    const prev = this.cache.get(path) ?? { rating: 0, favorite: false };
    this.cache.set(path, { ...prev, rating });
    this.notify(path);
    console.log(`[REVIEW] rating applied: ${path} = ${rating}`);
  }

  setFavorite(path: string, favorite: boolean): void {
    const prev = this.cache.get(path) ?? { rating: 0, favorite: false };
    this.cache.set(path, { ...prev, favorite });
    this.notify(path);
    console.log(`[REVIEW] favorite ${favorite ? 'on' : 'off'}: ${path}`);
  }

  loadBatch(entries: Array<{ foto_path: string; rating: number; favorite: boolean }>): void {
    for (const e of entries) {
      this.cache.set(e.foto_path, { rating: e.rating ?? 0, favorite: e.favorite ?? false });
    }
    // notify global listeners (batch update — callers that watch the whole store)
    for (const fn of this.listeners) fn();
    // notify per-path listeners for each updated path
    for (const e of entries) {
      const set = this.pathListeners.get(e.foto_path);
      if (set) for (const fn of set) fn();
    }
  }

  clear(): void {
    const paths = Array.from(this.cache.keys());
    this.cache.clear();
    for (const p of paths) this.notify(p);
    for (const fn of this.listeners) fn();
  }
}

export const ratingCache = new RatingCache();
