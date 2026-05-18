import { useState, useCallback, useEffect, useRef } from 'react';
import { api, type Photo } from '../services/api';
import { useApp } from '../context/AppContext';
import { timed } from '../utils/perf';

export function useCatalogPhotos() {
  const { currentCatalog, refreshKey } = useApp();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadPhotos = useCallback(async () => {
    // Cancelar request anterior se existir
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    if (!currentCatalog) {
      setPhotos([]);
      return;
    }
    setLoading(true);
    try {
      const arr = await timed('catalog photos load', () => api.getAllPhotos(currentCatalog), currentCatalog);
      if (!controller.signal.aborted) {
        setPhotos(arr);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        console.error(e);
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [currentCatalog, refreshKey]);

  useEffect(() => {
    Promise.resolve().then(loadPhotos);
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [loadPhotos]);

  const updatePhotoStatus = useCallback((path: string, updates: Partial<Photo>) => {
    setPhotos(prev => prev.map(p =>
      p.path === path ? { ...p, ...updates } : p
    ));
  }, []);

  const discardPhoto = useCallback((path: string) => {
    updatePhotoStatus(path, { discarded: true });
  }, [updatePhotoStatus]);

  const restorePhoto = useCallback((path: string) => {
    updatePhotoStatus(path, { discarded: false });
  }, [updatePhotoStatus]);

  return { photos, loading, loadPhotos, updatePhotoStatus, discardPhoto, restorePhoto };
}
