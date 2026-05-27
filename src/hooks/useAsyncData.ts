import { useState, useEffect, useRef, useCallback, type DependencyList } from 'react';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useAsyncData<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
): AsyncState<T> & { refresh: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  const abortRef = useRef<AbortController | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const execute = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState(prev => ({ ...prev, loading: true, error: null }));

    fetcherRef.current(controller.signal)
      .then(data => {
        if (!controller.signal.aborted) {
          setState({ data, loading: false, error: null });
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          const err = e as Error | null;
          if (err?.name !== 'AbortError') {
            setState({ data: null, loading: false, error: err?.message || 'Erro desconhecido' });
          }
        }
      });

    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(execute, deps);

  return { ...state, refresh: execute };
}
