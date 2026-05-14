export interface PhotoMeta {
  rating: number;
  favorite: boolean;
}

type Listener = () => void;

class RatingCache {
  private cache = new Map<string, PhotoMeta>();
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  get(path: string): PhotoMeta {
    return this.cache.get(path) ?? { rating: 0, favorite: false };
  }

  setRating(path: string, rating: number): void {
    const prev = this.cache.get(path) ?? { rating: 0, favorite: false };
    this.cache.set(path, { ...prev, rating });
    this.notify();
    console.log(`[REVIEW] rating applied: ${path} = ${rating}`);
  }

  setFavorite(path: string, favorite: boolean): void {
    const prev = this.cache.get(path) ?? { rating: 0, favorite: false };
    this.cache.set(path, { ...prev, favorite });
    this.notify();
    console.log(`[REVIEW] favorite ${favorite ? 'on' : 'off'}: ${path}`);
  }

  loadBatch(entries: Array<{ foto_path: string; rating: number; favorite: boolean }>): void {
    for (const e of entries) {
      this.cache.set(e.foto_path, { rating: e.rating ?? 0, favorite: e.favorite ?? false });
    }
    this.notify();
  }

  clear(): void {
    this.cache.clear();
    this.notify();
  }
}

export const ratingCache = new RatingCache();
