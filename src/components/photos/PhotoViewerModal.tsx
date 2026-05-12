import { useState, useEffect } from 'react';
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
  const [feedback, setFeedback] = useState<string | null>(null);
  const currentIndex = allPhotos.findIndex((p) => p.path === photo.path);
  const total = allPhotos.length;

  const showFeedback = (text: string) => {
    setFeedback(text);
    setTimeout(() => setFeedback(null), 2000);
  };

  const handleDiscard = async () => {
    try {
      await api.discardPhoto({ foto_path: photo.path, discard: true });
      showFeedback("Foto descartada");
      if (currentIndex < total - 1) onNavigate(allPhotos[currentIndex + 1]);
    } catch (err) {
      console.error("Erro ao descartar:", err);
    }
  };

  const handleRestore = async () => {
    try {
      await api.discardPhoto({ foto_path: photo.path, discard: false });
      showFeedback("Foto restaurada");
    } catch (err) {
      console.error("Erro ao restaurar:", err);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        handleDiscard();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        handleRestore();
      } else if (e.key === 'ArrowLeft') {
        if (currentIndex > 0) onNavigate(allPhotos[currentIndex - 1]);
      } else if (e.key === 'ArrowRight') {
        if (currentIndex < total - 1) onNavigate(allPhotos[currentIndex + 1]);
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photo, currentIndex, total, onNavigate, onClose]);

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
            if (face.x1 == null || !photo.width || !photo.height) return null;
            
            const imgRatio = photo.width / photo.height;
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
            
            const x1 = offsetX + (face.x1 / photo.width) * renderedW;
            const y1 = offsetY + (face.y1 / photo.height) * renderedH;
            const widthPx = ((face.x2 - face.x1) / photo.width) * renderedW;
            const heightPx = ((face.y2 - face.y1) / photo.height) * renderedH;

            const color = isKnown ? '#22c55e' : '#9ca3af';

            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: `${x1}px`, 
                  top: `${y1}px`,
                  width: `${widthPx}px`, 
                  height: `${heightPx}px`,
                  border: `2px solid ${color}`,
                  borderRadius: '6px',
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

          {feedback && (
            <div className="viewer-feedback">
              {feedback}
            </div>
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
