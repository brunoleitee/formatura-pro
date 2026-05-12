import React, { useState } from 'react';
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
    />
  );
}

export function PhotoCard({ photo, isSelected, onClick, onDoubleClick, onOpenDetails }: PhotoCardProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [thumbSize, setThumbSize] = useState({ w: 0, h: 0 });

  const isMapped = isPhotoMapped(photo);
  const isDiscarded = photo.discarded === true;
  const knownNames = (photo.faces ?? [])
    .filter(isKnownFace)
    .map((f) => f.aluno_id)
    .filter((v, idx, a) => a.indexOf(v) === idx);
  const firstName = knownNames.length > 0 ? knownNames.join(', ') : 'Não mapeada';

  return (
    <div
      className={`photo-card ${isSelected ? 'selected' : ''} ${isDiscarded ? 'discarded' : ''}`}
      onClick={(e) => onClick(photo, e)}
      onDoubleClick={() => onDoubleClick?.(photo)}
    >
      <div className="photo-img-placeholder">
        {!hasError && (
          <>
            <img
              src={api.thumbUrl(photo.path, 300)}
              alt={photo.name}
              loading="lazy"
              decoding="async"
              style={{ opacity: isLoaded ? 1 : 0 }}
              onLoad={(e) => {
                setIsLoaded(true);
                setThumbSize({ w: e.currentTarget.clientWidth, h: e.currentTarget.clientHeight });
              }}
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