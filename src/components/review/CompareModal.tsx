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

  useEffect(() => {
    if (!bestName || !cluster.cluster_id) return;
    setIsLoading(true);
    
    // Obter o catálogo atual (a partir da URL ou injetado, no ClusterDetail temos prop catalog)
    // Como CompareModal não recebe catalog, vamos assumir que ele pode ser extraído ou passado.
    // Olhando ClusterDetail, ele tem catalog. Vamos precisar passar catalog para o CompareModal.
    
    api.getStudentMatchPreview(catalog, cluster.cluster_id, bestName)
      .then(data => {
        setMatchData(data);
      })
      .catch(err => {
        console.error('[CompareModal] preview error:', err);
        setMatchData(null);
      })
      .finally(() => setIsLoading(false));
  }, [bestName, cluster.cluster_id]);

  const rep = cluster.representative;
  const leftImg = rep ? faceThumb(rep.path, rep.box, 400) : '';

  let rightImg = '';
  if (matchData && matchData.matched_student_face_box && matchData.matched_student_photo_path) {
    const box = matchData.matched_student_face_box;
    rightImg = api.faceThumbUrl(
      matchData.matched_student_photo_path,
      box[0], box[1], box[2], box[3],
      400
    );
  }

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
            {displayLabel} — {matchData ? Math.round(matchData.matched_similarity * 100) : Math.round(bestSim * 100)}% similaridade
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
              {rightImg ? <img src={rightImg} alt={bestName} className={styles.img} /> : <div className={styles.placeholder}>{isLoading ? 'Buscando...' : 'Sem imagem'}</div>}
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
