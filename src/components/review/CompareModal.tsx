import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { RichCluster, StudentMatchPreviewResponse } from '../../services/api';
import { api } from '../../services/api';
import { faceThumb } from './FaceCard';
import styles from './CompareModal.module.css';

interface CompareModalProps {
  cluster: RichCluster;
  catalog: string;
  bestName: string;
  bestSim: number;
  onConfirm: (name: string) => void;
  onReject: (name: string) => void;
  onClose: () => void;
}

function formatSimilarity(sim: number | null | undefined): string {
  if (sim == null || !isFinite(sim) || isNaN(sim)) return '--%';
  return `${Math.round(sim * 100)}%`;
}

export default function CompareModal({
  cluster,
  catalog,
  bestName,
  bestSim,
  onConfirm,
  onReject,
  onClose,
}: CompareModalProps) {
  const [matchData, setMatchData] = useState<StudentMatchPreviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const displayLabel = matchData?.matched_student_label || bestName;

  const similarity = matchData?.matched_similarity ?? bestSim;

  useEffect(() => {
    if (!bestName || !cluster.cluster_id) return;
    setIsLoading(true);

    api.getStudentMatchPreview(catalog, cluster.cluster_id, bestName)
      .then(data => {
        setMatchData(data);
        if (data?.matched_similarity == null || !isFinite(data.matched_similarity)) {
          console.warn(`[Review] invalid similarity for reference ${bestName}: ${data?.matched_similarity}`);
        }
      })
      .catch(err => {
        console.error('[CompareModal] preview error:', err);
        setMatchData(null);
      })
      .finally(() => setIsLoading(false));
  }, [bestName, cluster.cluster_id]);

  const rep = cluster.representative;
  const leftImg = rep ? faceThumb(rep.path, rep.box, 400) : '';

  // ── Imagem da referência: usar reference_path ou fallback por face_box ──
  let rightImg = '';
  let rightAlt = displayLabel;

  if (matchData) {
    // Prioridade 1: reference_path (thumb cache da referência)
    if (matchData.reference_path) {
      rightImg = `/api/thumb?path=${encodeURIComponent(matchData.reference_path)}&size=400`;
    }
    // Prioridade 2: face crop da foto do aluno
    else if (matchData.matched_student_face_box && matchData.matched_student_photo_path) {
      const box = matchData.matched_student_face_box;
      rightImg = api.faceThumbUrl(
        matchData.matched_student_photo_path,
        box[0], box[1], box[2], box[3],
        400
      );
    }
  }

  const rightPlaceholder = isLoading
    ? 'Buscando...'
    : matchData?.reference_missing
      ? `Referência ${displayLabel} não encontrada`
      : 'Sem imagem';

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
              {leftImg ? <img src={leftImg} alt="Grupo atual" className={styles.img} /> : <div className={styles.placeholder}>Sem imagem</div>}
            </div>
            <span className={styles.label}>Este grupo</span>
          </div>

          <div className={styles.side}>
            <div className={styles.imgWrap}>
              {rightImg ? <img src={rightImg} alt={rightAlt} className={styles.img} /> : <div className={styles.placeholder}>{rightPlaceholder}</div>}
            </div>
            <span className={styles.label}>Referência: {displayLabel}</span>
          </div>
        </div>

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
