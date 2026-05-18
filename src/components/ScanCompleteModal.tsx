import { CheckCircle2, ScanFace, Image as ImageIcon, Users, BookOpen, X } from 'lucide-react';
import styles from './ScanCompleteModal.module.css';

interface Props {
  show: boolean;
  totalPhotos: number;
  totalFaces: number;
  totalTime: string;
  onClose: () => void;
  onGoPeople: () => void;
  onGoReview: () => void;
}

export function ScanCompleteModal({ show, totalPhotos, totalFaces, totalTime, onClose, onGoPeople, onGoReview }: Props) {
  if (!show) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <button className={styles.closeBtn} onClick={onClose} title="Fechar">
          <X size={18} />
        </button>

        <div className={styles.iconWrap}>
          <CheckCircle2 size={48} className={styles.icon} />
        </div>

        <h2 className={styles.title}>Escaneamento concluído!</h2>
        <p className={styles.subtitle}>Confira o resumo abaixo</p>

        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <ImageIcon size={20} className={styles.statIcon} />
            <span className={styles.statValue}>{totalPhotos}</span>
            <span className={styles.statLabel}>Fotos processadas</span>
          </div>
          <div className={styles.statCard}>
            <ScanFace size={20} className={styles.statIconFace} />
            <span className={styles.statValue}>{totalFaces}</span>
            <span className={styles.statLabel}>Faces detectadas</span>
          </div>
        </div>

        {totalTime && (
          <div className={styles.timeRow}>
            <span className={styles.timeLabel}>Tempo total:</span>
            <span className={styles.timeValue}>{totalTime}</span>
          </div>
        )}

        <div className={styles.actions}>
          <button className={styles.actionBtn} onClick={onGoPeople}>
            <Users size={16} />
            <span>Formandos</span>
          </button>
          <button className={`${styles.actionBtn} ${styles.actionBtnPrimary}`} onClick={onGoReview}>
            <BookOpen size={16} />
            <span>Revisão</span>
          </button>
        </div>
      </div>
    </div>
  );
}
