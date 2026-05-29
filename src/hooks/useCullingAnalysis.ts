import { useState, useCallback } from 'react';
import { api, type Photo } from '../services/api';

export function useCullingAnalysis(onPhotoUpdate?: (photo: Photo) => void) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const discardPhoto = useCallback(async (photo: Photo, discard: boolean) => {
    setLoading(true);
    setError(null);
    try {
      await api.discardPhoto({ foto_path: photo.path, discard, scope: 'catalog' });
      const updated = {
        ...photo,
        discarded: discard,
        discarded_scope: discard ? 'global' : null,
        discarded_global: discard,
        discarded_local: false,
      };
      if (onPhotoUpdate) onPhotoUpdate(updated);
      return updated;
    } catch (err: unknown) {
      const errorObj = err as Error | null;
      console.error('[useCullingAnalysis] erro ao descartar/restaurar:', errorObj);
      setError(errorObj?.message || 'Falha na operação de descarte.');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [onPhotoUpdate]);

  const toggleFavorite = useCallback(async (photo: Photo) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.toggleFavorite(photo.path);
      const updated = { ...photo, favorite: res.favorite ? 1 : 0 };
      if (onPhotoUpdate) onPhotoUpdate(updated);
      return updated;
    } catch (err: unknown) {
      const errorObj = err as Error | null;
      console.error('[useCullingAnalysis] erro ao favoritar:', errorObj);
      setError(errorObj?.message || 'Falha ao favoritar foto.');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [onPhotoUpdate]);

  const setRating = useCallback(async (photo: Photo, rating: number) => {
    setLoading(true);
    setError(null);
    try {
      await api.setRating(photo.path, rating);
      const updated = { ...photo, rating };
      if (onPhotoUpdate) onPhotoUpdate(updated);
      return updated;
    } catch (err: unknown) {
      const errorObj = err as Error | null;
      console.error('[useCullingAnalysis] erro ao avaliar:', errorObj);
      setError(errorObj?.message || 'Falha ao avaliar foto.');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [onPhotoUpdate]);

  return {
    discardPhoto,
    toggleFavorite,
    setRating,
    loading,
    error,
  };
}
