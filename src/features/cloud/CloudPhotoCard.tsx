import { CalendarClock, FileImage, ImageOff, HardDrive } from 'lucide-react';
import type { CloudItem } from './types';
import styles from '../../views/CloudView.module.css';

type CloudPhotoCardProps = {
  photo: CloudItem;
};

function formatFileSize(size?: number | null) {
  if (!size || size <= 0) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function CloudPhotoCard({ photo }: CloudPhotoCardProps) {
  const sizeLabel = formatFileSize(photo.size);
  const thumbnailUrl = photo.thumbnailUrl || '';
  const modifiedLabel = photo.modifiedTime ? new Date(photo.modifiedTime).toLocaleDateString('pt-BR') : '';

  return (
    <article className={styles.photoCard}>
      <div className={styles.photoPreview}>
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt={photo.name} className={styles.photoImage} loading="lazy" />
        ) : (
          <div className={styles.photoPlaceholder} aria-hidden="true">
            <ImageOff size={26} />
          </div>
        )}
        <span className={styles.photoBadge}>Foto</span>
      </div>

      <div className={styles.photoMeta}>
        <div className={styles.photoTitleRow}>
          <FileImage size={14} />
          <span className={styles.photoName} title={photo.name}>{photo.name}</span>
        </div>
        <div className={styles.photoInfoRow}>
          {sizeLabel ? (
            <span>
              <HardDrive size={12} />
              {sizeLabel}
            </span>
          ) : (
            <span>
              <HardDrive size={12} />
              Tamanho indisponível
            </span>
          )}
          {photo.modifiedTime ? (
            <span title={photo.modifiedTime}>
              <CalendarClock size={12} />
              {modifiedLabel || 'Atualizada'}
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}
