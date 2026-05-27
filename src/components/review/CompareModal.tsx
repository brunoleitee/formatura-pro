import { useEffect, useMemo } from 'react';
import { Check, X } from 'lucide-react';
import type { RichCluster, StudentMatchPreviewResponse } from '../../services/api';
import { api } from '../../services/api';
import { faceThumb } from './FaceCard';
import { formatSimilarity } from '../../utils/format';
import styles from './CompareModal.module.css';

interface CompareModalProps {
  cluster: RichCluster;
  bestName: string;
  bestSim: number;
  matchData: StudentMatchPreviewResponse | null;
  isLoading: boolean;
  error?: string;
  onConfirm: (name: string) => void;
  onReject: (name: string) => void;
  onClose: () => void;
}

export default function CompareModal({
  cluster,
  bestName,
  bestSim,
  matchData,
  isLoading,
  error = '',
  onConfirm,
  onReject,
  onClose,
}: CompareModalProps) {
  const displayLabel = matchData?.matched_student_label || bestName;
  const similarity = matchData?.matched_similarity ?? bestSim;

  const leftImg = useMemo(
    () => cluster.representative ? faceThumb(cluster.representative.path, cluster.representative.box, 400) : '',
    [cluster.representative]
  );

  const { rightImg, rightPlaceholder } = useMemo(() => {
    const alt = displayLabel;
    let img = '';
    if (matchData) {
      if (matchData.reference_path) {
        img = `/api/thumb?path=${encodeURIComponent(matchData.reference_path)}&size=400`;
      } else if (matchData.matched_student_face_box && matchData.matched_student_photo_path) {
        const box = matchData.matched_student_face_box;
        img = api.faceThumbUrl(
          matchData.matched_student_photo_path,
          box[0], box[1], box[2], box[3], 400
        );
      }
    }
    const placeholder = isLoading
      ? 'Buscando...'
      : matchData?.reference_missing
        ? `Referência ${displayLabel} não encontrada`
        : 'Sem imagem';
    return { rightImg: img, rightPlaceholder: placeholder };
  }, [matchData, displayLabel, isLoading]);

  // Prevenir scroll do body quando modal está aberto
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>

        <div className={styles.header}>
          <h2 className={styles.title}>
            {displayLabel} — {formatSimilarity(similarity)} similaridade
          </h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Fechar">
            <X size={20} />
          </button>
        </div>

        <div className={styles.content}>
          <div className={styles.side}>
            <div className={styles.imgWrap}>
              {leftImg ? <img src={leftImg} alt="Grupo atual" className={styles.img} loading="lazy" /> : <div className={styles.placeholder}>Sem imagem</div>}
            </div>
            <span className={styles.label}>Este grupo</span>
          </div>

          <div className={styles.side}>
            <div className={styles.imgWrap}>
              {rightImg ? <img src={rightImg} alt={displayLabel} className={styles.img} loading="lazy" /> : <div className={styles.placeholder}>{rightPlaceholder}</div>}
            </div>
            <span className={styles.label}>Referência: {displayLabel}</span>
          </div>
        </div>

        {error && <div style={{ textAlign: 'center', color: 'var(--danger)', fontSize: '0.8rem', marginBottom: 12 }}>{error}</div>}

        <div className={styles.footer}>
          <button className={styles.btnSecondary} onClick={() => onReject(bestName)}>
            <X size={16} />
            <span>Não é {displayLabel}</span>
          </button>
          <button className={styles.btnPrimary} onClick={() => onConfirm(bestName)}>
            <Check size={16} />
            <span>Confirmar como {displayLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
