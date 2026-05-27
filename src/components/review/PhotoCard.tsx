import { memo, useState } from 'react';
import { Check } from 'lucide-react';
import type { RichClusterFace } from '../../services/api';
import { API_BASE } from '../../services/api/core';
import { getGridThumbUrl } from '../../utils/imageUrls';
import styles from './PhotoCard.module.css';

// O backend expande mais acima do rosto para preservar capelo e cabelo.
const FACE_EXPAND = 0.4;

function thumbUrl(face: RichClusterFace, size: number, mode: 'photo' | 'face') {
  if (!face.path) return '';
  if (mode === 'photo') {
    return getGridThumbUrl(face.path, size) ?? '';
  }
  if (!face.box || face.box.length < 4) {
    // sem bbox: fallback para foto completa
    return getGridThumbUrl(face.path, size) ?? '';
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
  
  if (face.is_foreground === 1 || (face.foreground_score && face.foreground_score >= 0.65)) {
    badges.push({ label: '1º plano', variant: 'success' });
  } else if (face.is_foreground === 0 || (face.foreground_score !== undefined && face.foreground_score !== null && face.foreground_score < 0.45)) {
    badges.push({ label: '2º plano', variant: 'warning' });
    if (face.background_penalty_reason) {
      badges.push({ label: face.background_penalty_reason, variant: 'warning' });
    }
  }

  return badges;
}

import type React from 'react';

interface PhotoCardProps {
  face: RichClusterFace;
  selected: boolean;
  onToggle: (e: React.MouseEvent<HTMLDivElement>) => void;
  onOpen?: (face: RichClusterFace) => void;
  clickMode?: 'select' | 'open';
  thumbSize?: number;
  viewMode?: 'photo' | 'face';
}

export const PhotoCard = memo(function PhotoCard({
  face,
  selected,
  onToggle,
  onOpen,
  clickMode = 'select',
  thumbSize = 400,
  viewMode = 'face',
}: PhotoCardProps) {
  const [loaded, setLoaded] = useState(false);
  const badges = getBadges(face);
  const modeClass = viewMode === 'photo' ? styles.photoCardPhotoMode : styles.photoCardFaceMode;

  return (
    <div
      className={`${styles.photoCard} ${modeClass} ${selected ? styles.selected : ''}`}
      onClick={(e) => {
        if (clickMode === 'open' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
          onOpen?.(face);
          return;
        }
        onToggle(e);
      }}
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
