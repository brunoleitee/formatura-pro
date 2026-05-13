import { memo, useMemo } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import type { Photo } from '../../services/api';
import { MemoPhotoCard } from './PhotoCard';
import { getPhotoId } from '../../hooks/usePhotoSelection';

interface PhotoGridProps {
  photos: Photo[];
  selectedPaths: Set<string>;
  onPhotoClick: (photo: Photo, event: React.MouseEvent) => void;
  onDoubleClick?: (photo: Photo) => void;
  onOpenDetails: (photo: Photo) => void;
  onDragStart?: (photo: Photo, event: React.PointerEvent) => void;
  onDragEnd?: (photo: Photo, event: React.PointerEvent) => void;
  onFirstThumbLoad?: () => void;
  zoom?: number;
  selectionCount?: number;
}

export const PhotoGrid = memo(function PhotoGrid({
  photos,
  selectedPaths,
  onPhotoClick,
  onDoubleClick,
  onOpenDetails,
  onDragStart,
  onDragEnd,
  onFirstThumbLoad,
  zoom = 180,
  selectionCount = 0,
}: PhotoGridProps) {
  const gridStyle = useMemo(() => ({ '--grid-item-size': `${zoom}px` } as React.CSSProperties), [zoom]);

  if (photos.length === 0) {
    return (
      <div className="empty-state">
        <ImageIcon size={48} opacity={0.3} />
        <h3>Nenhuma foto encontrada</h3>
        <p>Use "Escanear Pasta" na barra superior para adicionar fotos.</p>
      </div>
    );
  }

  return (
    <div className="photo-grid" style={gridStyle}>
      {photos.map((photo) => {
        const id = getPhotoId(photo);
        return (
          <MemoPhotoCard
            key={id}
            photo={photo}
            isSelected={selectedPaths.has(id)}
            selectionCount={selectionCount}
            onClick={onPhotoClick}
            onDoubleClick={onDoubleClick}
            onOpenDetails={onOpenDetails}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onFirstThumbLoad={onFirstThumbLoad}
          />
        );
      })}
    </div>
  );
});
