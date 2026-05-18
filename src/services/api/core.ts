import { logPerf } from '../../utils/perf';

// Em dev, o Vite proxy /api -> http://127.0.0.1:8000 (sem CORS).
// Em produção o FastAPI serve o frontend e /api fica no mesmo origin.
export const API_BASE = '/api';

// Deduplicação de requests GET idênticas em curto intervalo
const inflightRequests = new Map<string, { promise: Promise<unknown>; timestamp: number }>();
const DEDUPE_WINDOW_MS = 1000; // 1 segundo

function dedupeLog(msg: string) {
  if (typeof window !== 'undefined' && window.localStorage?.getItem('formaturapro:perf') === '1') {
    console.debug(`[perf-dedupe] ${msg}`);
  }
}

export async function fetchJSON<T = unknown>(url: string, options?: RequestInit): Promise<T> {
  const method = options?.method || 'GET';
  const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now();

  // Deduplicação apenas para GET requests sem AbortController
  const isGET = method === 'GET' && !options?.signal;
  const dedupeKey = isGET ? url : null;

  if (dedupeKey) {
    const existing = inflightRequests.get(dedupeKey);
    if (existing && Date.now() - existing.timestamp < DEDUPE_WINDOW_MS) {
      dedupeLog(`reaproveitando: ${dedupeKey}`);
      return existing.promise as Promise<T>;
    }
  }

  const fetchPromise = (async () => {
    const res = await fetch(url, options);
    try {
      const parsed = typeof window === 'undefined' ? null : new URL(url, window.location.origin);
      const label = parsed ? `${parsed.pathname}${parsed.search}` : url;
      logPerf(`api ${method} ${label}`, startedAt);
    } catch {
      logPerf(`api ${method} ${url}`, startedAt);
    }
    if (!res.ok) {
      let detail: string | undefined;
      try { detail = (await res.json()).detail; } catch {}
      if (res.status >= 500 && !detail) {
        detail = `server_error_${res.status}`;
      }
      const err: any = new Error(detail ?? `HTTP ${res.status}: ${res.statusText}`);
      err.status = res.status;
      err.detail = detail;
      throw err;
    }
    return res.json() as Promise<T>;
  })();

  if (dedupeKey) {
    inflightRequests.set(dedupeKey, { promise: fetchPromise, timestamp: Date.now() });
    fetchPromise.finally(() => {
      const entry = inflightRequests.get(dedupeKey);
      if (entry?.promise === fetchPromise) {
        inflightRequests.delete(dedupeKey);
      }
    });
  }

  return fetchPromise;
}

export function post<T = unknown>(url: string, body: unknown): Promise<T> {
  return fetchJSON<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
