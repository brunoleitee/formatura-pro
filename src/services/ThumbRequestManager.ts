import { isPerfLoggingEnabled } from '../utils/perf';

type Priority = 0 | 1 | 2;

interface RequestEntry {
  key: string;
  url: string;
  priority: Priority;
  controller: AbortController;
  promise: Promise<string>;
  resolve: (url: string) => void;
  reject: (err: Error) => void;
  addedAt: number;
  startedAt: number;
  nextTryAt?: number;
}

const ABORT_PROTECT_MS = 300;

class ThumbRequestManager {
  private active = new Map<string, RequestEntry>();
  private queue: RequestEntry[] = [];
  private MAX_ACTIVE = 12;
  private MAX_QUEUE = 150;
  private MAX_RETRIES = 3;

  private log(...args: unknown[]): void {
    if (isPerfLoggingEnabled()) {
      console.debug('[thumb-stable]', ...args);
    }
  }

  request(url: string, key: string, priority: Priority = 1, retryCount = 0): Promise<string> {
    const existing = this.active.get(key);
    if (existing) {
      this.log('reused active request', `key=${key}`);
      existing.priority = Math.max(existing.priority, priority);
      return existing.promise;
    }

    const queued = this.queue.find(e => e.key === key);
    if (queued) {
      this.log('skip duplicate', `key=${key}`);
      queued.priority = Math.max(queued.priority, priority);
      return queued.promise;
    }

    const controller = new AbortController();
    let resolveFn!: (url: string) => void;
    let rejectFn!: (err: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    this.queue.push({
      key, url, priority, controller, promise,
      resolve: resolveFn, reject: rejectFn,
      addedAt: Date.now(), startedAt: 0,
    } as RequestEntry & { retryCount?: number });
    (this.queue[this.queue.length - 1] as any).retryCount = retryCount;

    if (this.queue.length > this.MAX_QUEUE) this.dropLowestPriority();
    this.pump();
    return promise;
  }

  cancel(key: string): void {
    const active = this.active.get(key);
    if (active) {
      const age = Date.now() - active.startedAt;
      if (age > ABORT_PROTECT_MS) {
        this.log('skip abort visible', `key=${key} age=${age}ms`);
        return;
      }
      active.controller.abort();
      this.active.delete(key);
      return;
    }
    const idx = this.queue.findIndex(e => e.key === key);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
    }
  }

  cancelOnlyFarAwayRequests(viewportKeys: Set<string>): void {
    const now = Date.now();
    const kept: RequestEntry[] = [];
    let dropped = 0;
    let protected_count = 0;

    for (const entry of this.queue) {
      if (viewportKeys.has(entry.key)) {
        kept.push(entry);
      } else {
        const age = now - entry.addedAt;
        if (age < ABORT_PROTECT_MS) {
          protected_count++;
          kept.push(entry);
        } else {
          entry.reject(new DOMException('Cancelled', 'AbortError'));
          dropped++;
        }
      }
    }
    this.queue = kept;

    if (dropped > 0 || protected_count > 0) {
      this.log(`cancel-pass dropped=${dropped} protected=${protected_count} active=${this.active.size} queued=${this.queue.length}`);
    }
  }

  clear(): void {
    for (const entry of this.active.values()) entry.controller.abort();
    for (const entry of this.queue) entry.reject(new DOMException('Cancelled', 'AbortError'));
    this.active.clear();
    this.queue = [];
  }

  private dropLowestPriority(): void {
    let oldest = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (this.queue[i].addedAt < this.queue[oldest].addedAt) oldest = i;
    }
    const entry = this.queue.splice(oldest, 1)[0];
    entry.reject(new DOMException('Dropped', 'AbortError'));
    this.log('drop', `key=${entry.key}`);
  }

  private pump(): void {
    this.queue.sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);
    const now = Date.now();
    let i = 0;
    let minWait = Infinity;

    while (this.active.size < this.MAX_ACTIVE && i < this.queue.length) {
      const entry = this.queue[i];
      if (entry.nextTryAt && entry.nextTryAt > now) {
        const wait = entry.nextTryAt - now;
        if (wait < minWait) minWait = wait;
        i++;
        continue;
      }

      this.queue.splice(i, 1);
      entry.startedAt = Date.now();
      entry.nextTryAt = 0; // reset
      this.active.set(entry.key, entry);
      this.execute(entry);
    }

    if (minWait !== Infinity && minWait > 0) {
      setTimeout(() => this.pump(), minWait);
    }
  }

  isActive(key: string): boolean { return this.active.has(key); }
  isQueued(key: string): boolean { return this.queue.some(e => e.key === key); }
  get activeCount(): number { return this.active.size; }
  get queueCount(): number { return this.queue.length; }

  private async execute(entry: RequestEntry): Promise<void> {
    const started = performance.now();
    let isRetry = false;
    try {
      const response = await fetch(entry.url, {
        signal: entry.controller.signal,
        cache: 'default',
      });
      
      if (response.status === 202) {
        const retryCount = (entry as any).retryCount ?? 0;
        if (retryCount >= this.MAX_RETRIES) {
          entry.resolve(entry.url);
          return;
        }
        entry.nextTryAt = Date.now() + 1500;
        (entry as any).retryCount = retryCount + 1;
        isRetry = true;
        return;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      this.log('done', `key=${entry.key} ms=${Math.round(performance.now() - started)}`);
      entry.resolve(blobUrl);
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        entry.reject(new DOMException('Cancelled', 'AbortError'));
      } else {
        entry.resolve(entry.url);
      }
    } finally {
      this.active.delete(entry.key);
      if (isRetry && !entry.controller.signal.aborted) {
        this.queue.push(entry);
      }
      this.pump();
    }
  }

}

export const thumbManager = new ThumbRequestManager();
