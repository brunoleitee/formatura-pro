import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { RichCluster, Person } from '../../services/api';
import { api } from '../../services/api';
import { faceThumb } from './FaceCard';
import styles from './CompareModal.module.css';

interface CompareModalProps {
  cluster: RichCluster;
  bestName: string;
  bestSim: number;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export default function CompareModal({
  cluster,
  bestName,
  bestSim,
  onConfirm,
  onClose,
}: CompareModalProps) {
  const [student, setStudent] = useState<Person | null>(null);

  useEffect(() => {
    // Busca a referência da imagem do aluno (bestName)
    api.getPeople().then(people => {
      const match = people.find(p => p.id === bestName || p.name === bestName);
      if (match) {
        setStudent(match);
      }
    }).catch(console.error);
  }, [bestName]);

  const rep = cluster.representative;
  const leftImg = rep ? faceThumb(rep.path, rep.box, 400) : '';

  let rightImg = '';
  if (student && student.cover_path && student.cover_box) {
    rightImg = api.photoApi.faceThumbUrl(
      student.cover_path,
      student.cover_box[0],
      student.cover_box[1],
      student.cover_box[2],
      student.cover_box[3],
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
            {bestName} — {Math.round(bestSim * 100)}% similaridade
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
              {rightImg ? <img src={rightImg} alt={bestName} className={styles.img} /> : <div className={styles.placeholder}>Buscando...</div>}
            </div>
            <span className={styles.label}>Referência: {bestName}</span>
          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.btnSecondary} onClick={onClose}>
            <X size={16} />
            <span>Não é {bestName}</span>
          </button>
          <button className={styles.btnPrimary} onClick={() => onConfirm(bestName)}>
            <Check size={16} />
            <span>Confirmar como {bestName}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
