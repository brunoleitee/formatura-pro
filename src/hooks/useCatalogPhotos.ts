import { useState, useCallback, useEffect } from 'react';
import { api, type Photo } from '../services/api';
import { useApp } from '../context/AppContext';

export function useCatalogPhotos() {
  const { currentCatalog, refreshKey } = useApp();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);

  const loadPhotos = useCallback(async () => {
    if (!currentCatalog) return;
    setLoading(true);
    try {
      const arr = await api.getAllPhotos(currentCatalog);
      setPhotos(arr);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [currentCatalog, refreshKey]);

  useEffect(() => {
    Promise.resolve().then(loadPhotos);
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