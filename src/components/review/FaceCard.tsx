import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import { API_BASE } from '../../services/api/core';
import styles from './FaceCard.module.css';

export function faceThumb(path: string, box: [number, number, number, number], size: number) {
  return `${API_BASE}/thumb?path=${encodeURIComponent(path)}&x1=${box[0]}&y1=${box[1]}&x2=${box[2]}&y2=${box[3]}&size=${size}&expand=0.38`;
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
    <motion.button
      className={`${styles.card} ${styles[variant]} ${selected ? styles.selected : ''}`}
      onClick={onClick}
      whileHover={{ scale: 1.04, zIndex: 2 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
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
    </motion.button>
  );
});
