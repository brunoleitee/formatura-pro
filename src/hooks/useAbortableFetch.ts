import { useRef, useCallback, useEffect } from 'react';

export function useAbortableFetch() {
  const ref = useRef<AbortController | null>(null);

  const run = useCallback(async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
    ref.current?.abort();
    const controller = new AbortController();
    ref.current = controller;
    try {
      return await fn(controller.signal);
    } finally {
      if (ref.current === controller) ref.current = null;
    }
  }, []);

  useEffect(() => () => ref.current?.abort(), []);

  return run;
}
