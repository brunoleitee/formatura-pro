import { memo, useState } from 'react';
import { getFaceThumbUrl } from '../../utils/imageUrls';
import styles from './FaceCard.module.css';

export function faceThumb(path: string, box: [number, number, number, number], size: number) {
  return getFaceThumbUrl(path, box, size);
}

export interface FaceCardProps {
  path: string;
  box: [number, number, number, number];
  variant?: 'sm' | 'lg';
  selected?: boolean;
  onClick?: () => void;
}

export const FaceCard = memo(function FaceCard({
  path,
  box,
  variant = 'sm',
  selected = false,
  onClick,
}: FaceCardProps) {
  const [loaded, setLoaded] = useState(false);
  const px = variant === 'lg' ? 360 : 180;

  return (
    <button
      className={`${styles.card} ${styles[variant]} ${selected ? styles.selected : ''}`}
onClick={onClick}
      type="button"
    >
      <div className={styles.imgWrap}>
        <img
          src={faceThumb(path, box, px)}
          alt=""
          loading="lazy"
          decoding="async"
          className={`${styles.img} ${loaded ? styles.visible : ''}`}
          onLoad={() => setLoaded(true)}
          onError={e => {
            (e.currentTarget as HTMLImageElement).style.opacity = '0';
          }}
        />
        {!loaded && <div className={styles.skeleton} />}
      </div>
      {selected && <div className={styles.selectedRing} />}
    </button>
  );
});
