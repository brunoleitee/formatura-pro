import { memo, useState } from 'react';
import { ScanFace, ImageIcon } from 'lucide-react';
import { api } from '../../services/api';
import styles from '../../views/ScannerWorkspace.module.css';

const RAW_EXTENSIONS = ['cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'dng', 'raf'];

interface Props {
  path: string;
  ext?: string;
  isActive: boolean;
  onClick: (path: string) => void;
  onDoubleClick: (path: string) => void;
}

const ScannerPhotoCard = memo(function ScannerPhotoCard({ path, ext, isActive, onClick, onDoubleClick }: Props) {
  const fileExt = (ext || path.split('.').pop() || '').toLowerCase().replace('.', '');
  const isRawFile = RAW_EXTENSIONS.includes(fileExt);
  const [imgError, setImgError] = useState(false);
  const showFallback = imgError;
  const fallbackTitle = isRawFile ? 'RAW' : 'Erro';
  const fallbackSubtitle = isRawFile ? 'sem prévia' : 'miniatura indisponível';

  return (
    <div 
      className={`${styles.photoCard} ${isActive ? styles.photoCardActive : ''}`}
      onClick={() => onClick(path)}
      onDoubleClick={() => onDoubleClick(path)}
    >
      {showFallback ? (
        <div className={styles.rawPlaceholder}>
          <ImageIcon size={24} className={styles.rawIcon} />
          <span className={styles.rawLabel}>{fallbackTitle}</span>
          <span className={styles.rawSub}>{fallbackSubtitle}</span>
        </div>
      ) : (
        <img 
          src={api.thumbUrl(path, 300)} 
          alt="Preview" 
          className={styles.cardThumb} 
          loading="lazy"
          onError={() => setImgError(true)}
        />
      )}
      <div className={styles.cardOverlays}>
        <div className={styles.overlayTop}>
          <div className={styles.statsBadge}>
            <div className={styles.statIcon}><ScanFace size={10} /> IA</div>
          </div>
          {isRawFile && <div className={`${styles.badge} ${styles.badgeAmber}`} style={{ fontSize: 7, marginLeft: 4 }}>RAW</div>}
        </div>
        <div className={styles.overlayBottom}>
          <div className={styles.extBadge}>{fileExt.toUpperCase() || 'JPG'}</div>
        </div>
      </div>
    </div>
  );
});

export default ScannerPhotoCard;
