import { useState } from 'react';
import { Image as ImageIcon, MoreHorizontal } from 'lucide-react';
import { api, type Photo } from '../../services/api';
import { isPhotoBlurry, isPhotoAttention } from '../../utils/qualityUtils';
import { isPhotoMapped, isKnownFace } from '../../utils/personIdentity';

interface PhotoCardProps {
  photo: Photo;
  isSelected: boolean;
  onClick: (photo: Photo) => void;
  onOpenDetails: (photo: Photo) => void;
}

export function PhotoCard({ photo, isSelected, onClick, onOpenDetails }: PhotoCardProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [thumbSize, setThumbSize] = useState({ w: 0, h: 0 });

  const isMapped = isPhotoMapped(photo);
  const knownNames = (photo.faces ?? [])
    .filter(isKnownFace)
    .map((f) => f.aluno_id)
    .filter((v, idx, a) => a.indexOf(v) === idx);
  const firstName = knownNames.length > 0 ? knownNames.join(', ') : 'Não mapeada';

  return (
    <div
      className={`photo-card ${isSelected ? 'selected' : ''}`}
      onClick={() => onClick(photo)}
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
            {isLoaded && thumbSize.w > 0 && photo.width && photo.height && (photo.faces || []).map((face, i) => {
              if (face.x1 == null) return null;
              
              const imgRatio = photo.width! / photo.height!;
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
              
              const faceCenterX = offsetX + ((face.x1 + face.x2) / 2 / photo.width!) * renderedW;
              const faceCenterY = offsetY + ((face.y1 + face.y2) / 2 / photo.height!) * renderedH;
              
              const color = isKnown ? '#22c55e' : '#9ca3af';

              const widthPx = ((face.x2 - face.x1) / photo.width!) * renderedW;
              const heightPx = ((face.y2 - face.y1) / photo.height!) * renderedH;

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
    </div>
  );
}
