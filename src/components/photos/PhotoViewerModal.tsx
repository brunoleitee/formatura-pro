import { useState } from 'react';
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
  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  const [isLoaded, setIsLoaded] = useState(false);
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
          <img 
            src={api.thumbUrl(photo.path, 1200)} 
            alt={photo.name} 
            style={{ opacity: isLoaded ? 1 : 0 }}
            onLoad={(e) => {
              setIsLoaded(true);
              setViewSize({ w: e.currentTarget.clientWidth, h: e.currentTarget.clientHeight });
            }}
          />
          {isLoaded && viewSize.w > 0 && photo.width && photo.height && (photo.faces || []).map((face, i) => {
            if (face.x1 == null) return null;
            
            const imgRatio = photo.width! / photo.height!;
            const containerRatio = viewSize.w / viewSize.h;
            
            let renderedW = viewSize.w;
            let renderedH = viewSize.h;
            
            if (imgRatio > containerRatio) {
              renderedH = viewSize.w / imgRatio;
            } else {
              renderedW = viewSize.h * imgRatio;
            }
            
            const offsetX = (viewSize.w - renderedW) / 2;
            const offsetY = (viewSize.h - renderedH) / 2;

            const isKnown = isKnownFace(face);
            
            const faceCenterX = offsetX + ((face.x1 + face.x2) / 2 / photo.width!) * renderedW;
            const faceCenterY = offsetY + ((face.y1 + face.y2) / 2 / photo.height!) * renderedH;
            
            const widthPx = ((face.x2 - face.x1) / photo.width!) * renderedW;
            const heightPx = ((face.y2 - face.y1) / photo.height!) * renderedH;

            const color = isKnown ? '#22c55e' : '#9ca3af';

            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: `${faceCenterX}px`, top: `${faceCenterY}px`,
                  width: `${widthPx}px`, height: `${heightPx}px`,
                  border: `2px solid ${color}`,
                  borderRadius: '6px',
                  transform: 'translate(-50%, -50%)',
                  pointerEvents: 'none',
                  boxSizing: 'border-box',
                  zIndex: 1
                }}
              />
            );
          })}

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
