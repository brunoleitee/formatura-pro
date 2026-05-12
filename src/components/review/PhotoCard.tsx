import { memo, useState } from 'react';
import { Check } from 'lucide-react';
import type { RichClusterFace } from '../../services/api';
import { API_BASE } from '../../services/api/core';
import styles from './PhotoCard.module.css';

// expand=0.4 → backend adiciona 40% horizontal e 50% vertical ao redor do bbox do rosto
// resultado: cabeça inteira + ombros, sem mostrar muito fundo
const FACE_EXPAND = 0.4;

function thumbUrl(face: RichClusterFace, size: number, mode: 'photo' | 'face') {
  if (!face.path) return '';
  if (mode === 'photo') {
    return `${API_BASE}/image_thumb?path=${encodeURIComponent(face.path)}&size=${size}`;
  }
  if (!face.box || face.box.length < 4) {
    // sem bbox: fallback para foto completa
    return `${API_BASE}/image_thumb?path=${encodeURIComponent(face.path)}&size=${size}`;
  }
  const [x1, y1, x2, y2] = face.box;
  return `${API_BASE}/thumb?path=${encodeURIComponent(face.path)}&x1=${x1}&y1=${y1}&x2=${x2}&y2=${y2}&size=${size}&expand=${FACE_EXPAND}`;
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

import type React from 'react';

interface PhotoCardProps {
  face: RichClusterFace;
  selected: boolean;
  onToggle: (e: React.MouseEvent<HTMLDivElement>) => void;
  thumbSize?: number;
  viewMode?: 'photo' | 'face';
}

export const PhotoCard = memo(function PhotoCard({
  face,
  selected,
  onToggle,
  thumbSize = 400,
  viewMode = 'face',
}: PhotoCardProps) {
  const [loaded, setLoaded] = useState(false);
  const badges = getBadges(face);
  const modeClass = viewMode === 'photo' ? styles.photoCardPhotoMode : styles.photoCardFaceMode;

  return (
    <div
      className={`${styles.photoCard} ${modeClass} ${selected ? styles.selected : ''}`}
      onClick={onToggle}
      data-selectable-card="true"
      data-rowid={face.rowid}
    >
      {/* Wrapper da imagem — define altura/aspecto por modo */}
      <div className={styles.photoCardImageWrap}>
        {!loaded && <div className={styles.skeleton} />}
        <img
          src={thumbUrl(face, thumbSize, viewMode)}
          alt=""
          loading="lazy"
          decoding="async"
          className={`${styles.photoCardImage} ${loaded ? styles.visible : ''}`}
          onLoad={() => setLoaded(true)}
          onError={e => {
            (e.currentTarget as HTMLImageElement).style.opacity = '0';
            setLoaded(true);
          }}
        />
      </div>

      {/* Badge "Melhor match" */}
      <div className={`${styles.badgeBestMatch} ${face.is_representative ? styles.badgeVisible : styles.badgeHidden}`} data-interactive="true">
        <span>Melhor match</span>
      </div>

      {/* Checkmark de seleção */}
      <div className={`${styles.checkArea} ${selected ? styles.checkAreaSelected : ''}`} data-interactive="true">
        <span className={selected ? styles.checkVisible : styles.checkHidden}>
          <Check size={11} strokeWidth={3} />
        </span>
      </div>

      {/* Badges de qualidade */}
      <div className={`${styles.badgesRow} ${badges.length > 0 ? styles.badgesVisible : styles.badgesHidden}`} data-interactive="true">
        {badges.map(b => (
          <span key={b.label} className={`${styles.badge} ${styles[b.variant]}`}>
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
});
