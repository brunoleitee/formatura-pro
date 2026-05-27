import { createContext, useContext, type RefObject } from 'react';
import type { Photo } from '../services/api';

export interface PhotoGridContextValue {
  selectedPaths: Set<string>;
  containerRef: RefObject<HTMLDivElement | null>;
  onPhotoClick: (photo: Photo, event: React.MouseEvent) => void;
  onDoubleClick: (photo: Photo) => void;
  onOpenDetails: (photo: Photo) => void;
  onDragStart: (photo: Photo, event: React.PointerEvent) => void;
  onDragEnd: (photo: Photo, event: React.PointerEvent) => void;
  getSelectionCount: () => number;
}

export const PhotoGridContext = createContext<PhotoGridContextValue | null>(null);

export function usePhotoGridContext(): PhotoGridContextValue {
  const ctx = useContext(PhotoGridContext);
  if (!ctx) throw new Error('usePhotoGridContext must be used within PhotoGridContext.Provider');
  return ctx;
}
