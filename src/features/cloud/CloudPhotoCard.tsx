import { ImageOff } from 'lucide-react';
import type { CloudItem } from './types';
import styles from '../../views/CloudView.module.css';

type CloudPhotoCardProps = {
  photo: CloudItem;
};

function formatDate(value?: string | null) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString('pt-BR');
  } catch {
    return '';
  }
}

export function CloudPhotoCard({ photo }: CloudPhotoCardProps) {
  const dateLabel = formatDate(photo.modifiedTime);

  return (
    <article className={styles.photoCard}>
      <div className={styles.photoThumb}>
        {photo.thumbnailUrl ? (
          <img src={photo.thumbnailUrl} alt={photo.name} className={styles.photoImage} loading="lazy" />
        ) : (
          <div className={styles.photoPlaceholder} aria-hidden="true">
            <ImageOff size={24} />
          </div>
        )}
      </div>
      <div className={styles.photoMeta}>
        <strong className={styles.photoName} title={photo.name}>{photo.name}</strong>
        {dateLabel ? <span className={styles.photoDate}>{dateLabel}</span> : null}
      </div>
    </article>
  );
}
