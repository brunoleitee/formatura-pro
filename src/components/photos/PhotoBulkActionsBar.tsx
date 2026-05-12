import React from 'react';
import { Trash, RotateCcw, UserMinus } from 'lucide-react';
import styles from './PhotoBulkActionsBar.module.css';

interface PhotoBulkActionsBarProps {
  selectedCount: number;
  onDiscard: () => void;
  onRestore: () => void;
  onRemoveIdentification: () => void;
}

const PhotoBulkActionsBar: React.FC<PhotoBulkActionsBarProps> = ({
  selectedCount,
  onDiscard,
  onRestore,
  onRemoveIdentification,
}) => {
  if (selectedCount === 0) return null;

  return (
    <div className={styles.bar}>
      <div className={styles.container}>
        <div className={styles.info}>
          <span className={styles.count}>{selectedCount}</span>
          <span className={styles.label}>foto{selectedCount !== 1 ? 's' : ''} selecionada{selectedCount !== 1 ? 's' : ''}</span>
        </div>

        <div className={styles.actions}>
          <button 
            className={`${styles.actionBtn} ${styles.discard}`} 
            onClick={onDiscard}
            data-bulk-action="discard"
          >
            <div className={styles.btnIcon}><Trash size={20} /></div>
            <div className={styles.btnText}>
              <span className={styles.hint}>Clique ou solte aqui para</span>
              <span className={styles.main}>Descartar</span>
            </div>
          </button>

          <button 
            className={`${styles.actionBtn} ${styles.restore}`} 
            onClick={onRestore}
            data-bulk-action="restore"
          >
            <div className={styles.btnIcon}><RotateCcw size={20} /></div>
            <div className={styles.btnText}>
              <span className={styles.hint}>Clique ou solte aqui para</span>
              <span className={styles.main}>Restaurar</span>
            </div>
          </button>

          <button 
            className={`${styles.actionBtn} ${styles.removeIdent}`} 
            onClick={onRemoveIdentification}
            data-bulk-action="remove-identification"
          >
            <div className={styles.btnIcon}><UserMinus size={20} /></div>
            <div className={styles.btnText}>
              <span className={styles.hint}>Clique ou solte aqui para</span>
              <span className={styles.main}>Remover identificação</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};

export default PhotoBulkActionsBar;
