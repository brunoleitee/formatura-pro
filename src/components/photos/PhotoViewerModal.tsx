import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, type Photo } from '../../services/api';

interface PhotoViewerModalProps {
  photo: Photo;
  allPhotos: Photo[];
  onClose: () => void;
  onNavigate: (photo: Photo) => void;
}

export function PhotoViewerModal({ photo, allPhotos, onClose, onNavigate }: PhotoViewerModalProps) {
  const currentIndex = allPhotos.findIndex((p) => p.path === photo.path);
  const total = allPhotos.length;

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentIndex > 0) onNavigate(allPhotos[currentIndex - 1]);
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentIndex < total - 1) onNavigate(allPhotos[currentIndex + 1]);
  };

  return (
    <div className="photo-viewer-modal" onClick={onClose}>
      <div className="photo-viewer-content" onClick={(e) => e.stopPropagation()}>
        <button className="viewer-close" onClick={onClose}>
          <X size={24} />
        </button>
        <div className="viewer-image-wrap">
          {currentIndex > 0 && (
            <button className="viewer-nav viewer-prev" onClick={handlePrev}>
              <ChevronLeft size={32} />
            </button>
          )}
          <img src={api.thumbUrl(photo.path, 1200)} alt={photo.name} />
          {currentIndex < total - 1 && (
            <button className="viewer-nav viewer-next" onClick={handleNext}>
              <ChevronRight size={32} />
            </button>
          )}
        </div>
        <div className="viewer-footer">
          <span className="viewer-name">{photo.name}</span>
          <span className="viewer-counter">
            {currentIndex + 1} / {total}
          </span>
        </div>
      </div>
    </div>
  );
}
