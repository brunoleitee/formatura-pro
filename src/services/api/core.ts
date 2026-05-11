// Em dev, o Vite proxy /api → http://127.0.0.1:8000 (sem CORS).
// Em produção o FastAPI serve o frontend e /api fica no mesmo origin.
export const API_BASE = '/api';

export async function fetchJSON<T = unknown>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

export function post<T = unknown>(url: string, body: unknown): Promise<T> {
  return fetchJSON<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
