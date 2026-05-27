import { useState, useCallback, useEffect, useRef } from 'react';
import { api, type Photo } from '../services/api';
import { useApp } from '../context/AppContext';
import { timed } from '../utils/perf';

const PAGE_SIZE = 100;

export function useCatalogPhotos() {
  const { currentCatalog, catalogSubfolder, refreshKey } = useApp();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const nextOffsetRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const loadPhotos = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (!currentCatalog) {
      setPhotos([]);
      setTotal(0);
      setHasMore(false);
      return;
    }

    setLoading(true);
    nextOffsetRef.current = 0;
    try {
      const result = await timed('catalog photos load', () =>
        api.getPhotosPage(currentCatalog, PAGE_SIZE, 0, catalogSubfolder), currentCatalog
      );
      if (!controller.signal.aborted) {
        setPhotos(result.photos);
        setTotal(result.total);
        setHasMore(result.hasMore);
        nextOffsetRef.current = PAGE_SIZE;
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        console.error(e);
        setError('Erro ao carregar fotos.');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [currentCatalog, catalogSubfolder, refreshKey]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || loading || !currentCatalog || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const offset = nextOffsetRef.current;
    try {
      const result = await api.getPhotosPage(currentCatalog, PAGE_SIZE, offset, catalogSubfolder);
      setPhotos(prev => [...prev, ...result.photos]);
      setHasMore(result.hasMore);
      nextOffsetRef.current = offset + PAGE_SIZE;
    } catch (e: any) {
      console.error(e);
      setError('Erro ao carregar mais fotos.');
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, loading, currentCatalog, catalogSubfolder]);

  useEffect(() => {
    Promise.resolve().then(loadPhotos);
    return () => {
      if (abortRef.current) abortRef.current.abort();
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

  return { photos, total, hasMore, loading, loadingMore, error, loadPhotos, loadMore, updatePhotoStatus, discardPhoto, restorePhoto };
}
