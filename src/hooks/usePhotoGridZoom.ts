import { useState, useEffect } from 'react';

const ZOOM_MIN = 80;
const ZOOM_MAX = 600;

export function usePhotoGridZoom(storageKey = 'formaturapro:grid-zoom', defaultValue = 60) {
  const [zoom, setZoom] = useState<number>(() => {
    try {
      const cached = localStorage.getItem(storageKey);
      return cached !== null ? parseInt(cached, 10) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(zoom));
    } catch (e) {
      console.warn('Falha ao persistir zoom no localStorage:', e);
    }
  }, [zoom, storageKey]);

  const size = ZOOM_MIN + (zoom / 100) * (ZOOM_MAX - ZOOM_MIN);

  return {
    zoom,
    setZoom,
    size,
    min: 0,
    max: 100,
  };
}
