import { useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { api, type Photo } from '../../services/api';
import { isPhotoBlurry, isPhotoAttention } from '../../utils/qualityUtils';
import { isPhotoMapped, isKnownFace } from '../../utils/personIdentity';

interface PhotoCardProps {
  photo: Photo;
  isSelected: boolean;
  onClick: (photo: Photo) => void;
}

export function PhotoCard({ photo, isSelected, onClick }: PhotoCardProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

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
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            <div style={{
              position: 'relative',
              maxWidth: '100%',
              maxHeight: '100%',
              display: 'inline-block'
            }}>
              <img
                src={api.thumbUrl(photo.path, 300)}
                alt={photo.name}
                loading="lazy"
                decoding="async"
                style={{ opacity: isLoaded ? 1 : 0, display: 'block', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                onLoad={() => setIsLoaded(true)}
                onError={() => setHasError(true)}
              />
              {isLoaded && photo.width && photo.height && (photo.faces || []).map((face, i) => {
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
