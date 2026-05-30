import { logPerf } from '../../utils/perf';

// Classe de erro HTTP estritamente tipada
export class HTTPError extends Error {
  status: number;
  detail?: string;

  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = 'HTTPError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, HTTPError.prototype);
  }
}

// Em dev, o Vite proxy /api -> http://127.0.0.1:8000 (sem CORS).
// Em produção, apontamos direto para o localhost absoluto na porta 8000,
// onde o sidecar Python roda. `import.meta.env.DEV` é mais confiável que
// inferir o ambiente pelo protocol/hostname da janela.
export const API_BASE = import.meta.env.DEV
  ? '/api'
  : 'http://127.0.0.1:8000/api';

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
      const errorMessage = detail ?? `HTTP ${res.status}: ${res.statusText}`;
      throw new HTTPError(res.status, errorMessage, detail);
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
    }).catch(() => {
      // A chamada original continua rejeitando para o caller; este catch evita
      // rejeição órfã do Promise criado pelo finally usado só para limpeza.
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
