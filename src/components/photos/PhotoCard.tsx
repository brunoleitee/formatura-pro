import { useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { api, type Photo } from '../../services/api';
import { isPhotoBlurry, isPhotoAttention } from '../../utils/qualityUtils';
import { isPhotoMapped, isKnownFace } from '../../utils/photoMapping';

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
          <img
            src={api.thumbUrl(photo.path, 300)}
            alt={photo.name}
            loading="lazy"
            decoding="async"
            style={{ opacity: isLoaded ? 1 : 0 }}
            onLoad={() => setIsLoaded(true)}
            onError={() => setHasError(true)}
          />
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
