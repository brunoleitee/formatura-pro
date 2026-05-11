import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, type Photo } from '../../services/api';
import { isKnownFace } from '../../utils/personIdentity';

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
          <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            <div style={{
              position: 'relative',
              maxWidth: '100%',
              maxHeight: '100%',
              display: 'inline-block'
            }}>
              <img src={api.thumbUrl(photo.path, 1200)} alt={photo.name} style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              {photo.width && photo.height && (photo.faces || []).map((face, i) => {
                if (face.x1 == null) return null;
                const isKnown = isKnownFace(face);
                const color = isKnown ? '#22c55e' : '#9ca3af';
                const left = (face.x1 / photo.width!) * 100;
                const top = (face.y1 / photo.height!) * 100;
                const width = ((face.x2 - face.x1) / photo.width!) * 100;
                const height = ((face.y2 - face.y1) / photo.height!) * 100;
                return (
                  <div
                    key={i}
                    className={`face-box ${isKnown ? 'known' : 'unknown'}`}
                    style={{
                      position: 'absolute',
                      left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%`,
                      border: `2px solid ${color}`,
                      pointerEvents: 'none',
                      boxSizing: 'border-box'
                    }}
                  />
                );
              })}
            </div>
          </div>
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
