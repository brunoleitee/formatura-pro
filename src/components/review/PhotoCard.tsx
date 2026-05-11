import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import type { RichClusterFace } from '../../services/api';
import styles from './PhotoCard.module.css';

const API_BASE = 'http://127.0.0.1:8000/api';

function photoThumb(path: string, size: number) {
  return `${API_BASE}/image_thumb?path=${encodeURIComponent(path)}&size=${size}`;
}

interface Badge {
  label: string;
  variant: 'success' | 'info' | 'warning';
}

function getBadges(face: RichClusterFace): Badge[] {
  const badges: Badge[] = [];
  if (face.blur_status === 'sharp') badges.push({ label: 'Nítida', variant: 'info' });
  else if (face.blur_status === 'attention') badges.push({ label: 'Suave', variant: 'warning' });
  if (face.closed_eyes) badges.push({ label: 'Olhos fechados', variant: 'warning' });
  return badges;
}

interface PhotoCardProps {
  face: RichClusterFace;
  selected: boolean;
  onToggle: () => void;
  thumbSize?: number;
}

export const PhotoCard = memo(function PhotoCard({
  face,
  selected,
  onToggle,
  thumbSize = 400,
}: PhotoCardProps) {
  const [loaded, setLoaded] = useState(false);
  const badges = getBadges(face);

  return (
    <motion.div
      className={`${styles.card} ${selected ? styles.selected : ''}`}
      whileHover={{ scale: 1.02 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      onClick={onToggle}
    >
      {/* Foto completa */}
      <div className={styles.imgWrap}>
        {!loaded && <div className={styles.skeleton} />}
        <img
          src={photoThumb(face.path, thumbSize)}
          alt=""
          loading="lazy"
          decoding="async"
          className={`${styles.img} ${loaded ? styles.visible : ''}`}
          onLoad={() => setLoaded(true)}
          onError={e => {
            (e.currentTarget as HTMLImageElement).style.opacity = '0';
            setLoaded(true);
          }}
        />
      </div>

      {/* Badge "Melhor match" (topo esquerdo) */}
      {face.is_representative && (
        <div className={styles.badgeBestMatch}>
          Melhor match
        </div>
      )}

      {/* Checkmark de seleção (topo direito) */}
      <div className={`${styles.checkArea} ${selected ? styles.checkAreaSelected : ''}`}>
        {selected && <Check size={12} strokeWidth={3} />}
      </div>

      {/* Badges de qualidade (rodapé) */}
      {badges.length > 0 && (
        <div className={styles.badgesRow}>
          {badges.map(b => (
            <span key={b.label} className={`${styles.badge} ${styles[b.variant]}`}>
              {b.label}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
});
