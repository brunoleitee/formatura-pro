import { CheckCircle2, FolderSearch } from 'lucide-react';
import styles from './CloudWorkflowPanel.module.css';

type CloudReferenceDetectionProps = {
  references: string[];
  loading?: boolean;
  onChangeReferences: () => void;
};

export function CloudReferenceDetection({
  references,
  loading = false,
  onChangeReferences,
}: CloudReferenceDetectionProps) {
  return (
    <div className={styles.referenceBox}>
      <div className={styles.referenceHeader}>
        <span>
          <CheckCircle2 size={15} />
          {loading
            ? 'Analisando referências...'
            : `${references.length} ${references.length === 1 ? 'pasta de referência detectada' : 'pastas de referência detectadas'}`}
        </span>
        <button type="button" className={styles.ghostButton} onClick={onChangeReferences}>
          <FolderSearch size={14} />
          Alterar referências
        </button>
      </div>

      {references.length > 0 ? (
        <ul className={styles.referenceList}>
          {references.map(reference => (
            <li key={reference}>{reference}</li>
          ))}
        </ul>
      ) : (
        <p className={styles.mutedLine}>Nenhuma pasta com BASE ou REFERENCIA foi encontrada.</p>
      )}
    </div>
  );
}
