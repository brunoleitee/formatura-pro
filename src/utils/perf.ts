const PERF_FLAG = 'formaturapro:perf';

function getWindow() {
  return typeof window === 'undefined' ? null : window;
}

export function isPerfLoggingEnabled() {
  const win = getWindow();
  if (!win) return false;
  try {
    return import.meta.env.DEV || win.localStorage.getItem(PERF_FLAG) === '1';
  } catch {
    return import.meta.env.DEV;
  }
}

export function perfNow() {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

export function logPerf(label: string, startedAt: number, extra?: string) {
  if (!isPerfLoggingEnabled()) return;
  const elapsed = perfNow() - startedAt;
  const suffix = extra ? ` ${extra}` : '';
  console.debug(`[perf] ${label}: ${elapsed.toFixed(1)}ms${suffix}`);
}

export async function timed<T>(label: string, fn: () => Promise<T>, extra?: string) {
  const startedAt = perfNow();
  try {
    return await fn();
  } finally {
    logPerf(label, startedAt, extra);
  }
}
