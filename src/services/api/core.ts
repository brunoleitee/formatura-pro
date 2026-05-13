import { logPerf } from '../../utils/perf';

// Em dev, o Vite proxy /api -> http://127.0.0.1:8000 (sem CORS).
// Em produção o FastAPI serve o frontend e /api fica no mesmo origin.
export const API_BASE = '/api';

export async function fetchJSON<T = unknown>(url: string, options?: RequestInit): Promise<T> {
  const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
  const res = await fetch(url, options);
  try {
    const parsed = typeof window === 'undefined' ? null : new URL(url, window.location.origin);
    const label = parsed ? `${parsed.pathname}${parsed.search}` : url;
    logPerf(`api ${options?.method || 'GET'} ${label}`, startedAt);
  } catch {
    logPerf(`api ${options?.method || 'GET'} ${url}`, startedAt);
  }
  if (!res.ok) {
    let detail: string | undefined;
    try { detail = (await res.json()).detail; } catch {}
    const err: any = new Error(detail ?? `HTTP ${res.status}: ${res.statusText}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res.json() as Promise<T>;
}

export function post<T = unknown>(url: string, body: unknown): Promise<T> {
  return fetchJSON<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
