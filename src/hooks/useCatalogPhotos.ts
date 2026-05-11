import { useState, useCallback, useEffect } from 'react';
import { api, type Photo } from '../services/api';
import { useApp } from '../context/AppContext';

export function useCatalogPhotos() {
  const { currentCatalog, refreshKey } = useApp();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);

  const loadPhotos = useCallback(async () => {
    if (!currentCatalog) return;
    setPhotos([]);
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

  return { photos, loading, loadPhotos };
}
