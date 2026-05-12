import React, { useState, useEffect, useRef } from 'react';
import { Image as ImageIcon, MoreHorizontal } from 'lucide-react';
import { api, type Photo } from '../../services/api';
import { isPhotoBlurry, isPhotoAttention } from '../../utils/qualityUtils';
import { isPhotoMapped, isKnownFace } from '../../utils/personIdentity';

interface PhotoCardProps {
  photo: Photo;
  isSelected: boolean;
  onClick: (photo: Photo, event: React.MouseEvent) => void;
  onDoubleClick?: (photo: Photo) => void;
  onOpenDetails: (photo: Photo) => void;
  onLongPress?: (photo: Photo) => void;
}

function renderFaceOverlay(face: Photo['faces'][number], thumbSize: { w: number, h: number }, photoWidth: number, photoHeight: number) {
  if (face.x1 == null || !photoWidth || !photoHeight) return null;

  const imgRatio = photoWidth / photoHeight;
  const containerRatio = thumbSize.w / thumbSize.h;

  let renderedW = thumbSize.w;
  let renderedH = thumbSize.h;

  if (imgRatio > containerRatio) {
    renderedH = thumbSize.w / imgRatio;
  } else {
    renderedW = thumbSize.h * imgRatio;
  }

  const offsetX = (thumbSize.w - renderedW) / 2;
  const offsetY = (thumbSize.h - renderedH) / 2;
  const isKnown = isKnownFace(face);

  const x1 = offsetX + (face.x1 / photoWidth) * renderedW;
  const y1 = offsetY + (face.y1 / photoHeight) * renderedH;
  const widthPx = ((face.x2 - face.x1) / photoWidth) * renderedW;
  const heightPx = ((face.y2 - face.y1) / photoHeight) * renderedH;
  const color = isKnown ? '#22c55e' : '#9ca3af';

  return (
    <div
      key={face.rowid ?? Math.random()}
      style={{
        position: 'absolute',
        left: `${x1}px`,
        top: `${y1}px`,
        width: `${widthPx}px`,
        height: `${heightPx}px`,
        border: `2px solid ${color}`,
        borderRadius: '4px',
        pointerEvents: 'none',
        boxSizing: 'border-box',
        zIndex: 1
      }}
    >
      {(face.is_foreground === 1 || (face.foreground_score && face.foreground_score >= 0.65)) && (
        <div style={{ position: 'absolute', top: '-20px', left: '-2px', background: '#10b981', color: 'white', fontSize: '10px', padding: '2px 4px', borderRadius: '4px', whiteSpace: 'nowrap' }}>
          1º plano
        </div>
      )}
      {(face.is_foreground === 0 || (face.foreground_score !== undefined && face.foreground_score !== null && face.foreground_score < 0.45)) && (
        <div style={{ position: 'absolute', top: '-20px', left: '-2px', background: '#f59e0b', color: 'white', fontSize: '10px', padding: '2px 4px', borderRadius: '4px', whiteSpace: 'nowrap' }}>
          2º plano {face.background_penalty_reason ? `(${face.background_penalty_reason})` : ''}
        </div>
      )}
    </div>
  );
}

export function PhotoCard({ photo, isSelected, onClick, onDoubleClick, onOpenDetails, onLongPress }: PhotoCardProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [thumbSize, setThumbSize] = useState({ w: 0, h: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const holdTimerRef = useRef<any>(null);

  const isMapped = isPhotoMapped(photo);
  const isDiscarded = photo.discarded === true;
  const knownNames = (photo.faces ?? [])
    .filter(isKnownFace)
    .map((f) => f.aluno_id)
    .filter((v, idx, a) => a.indexOf(v) === idx);
  const firstName = knownNames.length > 0 ? knownNames.join(', ') : 'Não mapeada';

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setThumbSize({ w: rect.width, h: rect.height });
        if (!isLoaded) setIsLoaded(true);
      }
    };

    measure();

    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click
    holdTimerRef.current = setTimeout(() => {
      onLongPress?.(photo);
    }, 350);
  };

  const clearTimer = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  return (
    <div
      className={`photo-card ${isSelected ? 'selected' : ''} ${isDiscarded ? 'discarded' : ''}`}
      onClick={(e) => onClick(photo, e)}
      onDoubleClick={() => onDoubleClick?.(photo)}
      onMouseDown={handleMouseDown}
      onMouseUp={clearTimer}
      onMouseLeave={clearTimer}
    >
      <div className="photo-img-placeholder" ref={containerRef}>
        {!hasError && (
          <>
            <img
              ref={imgRef}
              src={api.thumbUrl(photo.path, 300)}
              alt={photo.name}
              loading="lazy"
              decoding="async"
              style={{ opacity: isLoaded ? 1 : 0 }}
              onError={() => setHasError(true)}
            />
            <button
              data-interactive="true"
              onClick={(e) => {
                e.stopPropagation();
                onOpenDetails(photo);
              }}
              title="Ver detalhes"
              className="photo-card-details-btn"
              style={{
                position: 'absolute',
                top: '6px',
                right: '6px',
                zIndex: 10,
                background: 'rgba(0,0,0,0.6)',
                border: 'none',
                borderRadius: '4px',
                padding: '4px',
                color: 'white',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: 0.8,
                transition: 'opacity 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
              onMouseLeave={(e) => e.currentTarget.style.opacity = '0.8'}
            >
              <MoreHorizontal size={16} />
            </button>
            {isLoaded && thumbSize.w > 0 && photo.width && photo.height && (photo.faces || []).map((face, idx) => (
                <React.Fragment key={face.rowid ?? idx}>
                  {renderFaceOverlay(face, thumbSize, photo.width!, photo.height!)}
                </React.Fragment>
              ))}
          </>
        )}
        {!isLoaded && !hasError && <div className="photo-skeleton" />}
        {hasError && (
          <div className="photo-error-fallback">
            <ImageIcon size={24} opacity={0.4} />
            <span>Erro</span>
          </div>
        )}
        {isPhotoBlurry(photo) && (
          <div className="blur-badge blur-blurry">Desfocada</div>
        )}
        {isPhotoAttention(photo) && (
          <div className="blur-badge blur-attention">Verificar foco</div>
        )}
        {isDiscarded && (
          <div className="discardBadge">DESCARTADA</div>
        )}
      </div>
      <div className="photo-info">
        <div className="photo-name" title={photo.name}>
          {photo.name}
        </div>
        <div className="photo-status">
          <div className={`status-indicator ${isMapped ? 'mapped' : 'unmapped'}`} />
          <span>{firstName}</span>
        </div>
      </div>
      <div
        className={`photo-card-check ${isSelected ? 'photo-card-check-visible' : 'photo-card-check-hidden'}`}
        aria-hidden={!isSelected}
        style={{
          position: 'absolute',
          top: '8px',
          left: '8px',
          background: '#3b82f6',
          color: 'white',
          borderRadius: '50%',
          width: '24px',
          height: '24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: isSelected ? 1 : 0,
          transition: 'opacity 0.2s',
          pointerEvents: 'none',
          zIndex: 20,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
    </div>
  );
}