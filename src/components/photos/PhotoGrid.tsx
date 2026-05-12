import { Image as ImageIcon } from 'lucide-react';
import type { Photo } from '../../services/api';
import { PhotoCard } from './PhotoCard';

interface PhotoGridProps {
  photos: Photo[];
  selectedPaths: Set<string>;
  onPhotoClick: (photo: Photo, event: React.MouseEvent) => void;
  onDoubleClick?: (photo: Photo) => void;
  onOpenDetails: (photo: Photo) => void;
}

export function PhotoGrid({ photos, selectedPaths, onPhotoClick, onDoubleClick, onOpenDetails }: PhotoGridProps) {
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
    <div className="photo-grid">
      {photos.map((photo) => (
        <PhotoCard
          key={photo.path}
          photo={photo}
          isSelected={selectedPaths.has(photo.path)}
          onClick={onPhotoClick}
          onDoubleClick={onDoubleClick}
          onOpenDetails={onOpenDetails}
        />
      ))}
    </div>
  );
}
