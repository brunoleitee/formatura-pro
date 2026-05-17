import { Folder, PencilLine, Play, Trash2 } from 'lucide-react';
import type { CatalogFolder } from '../../services/api';
import styles from '../CatalogSettingsView.module.css';

interface Props {
  folder: CatalogFolder;
  onRemove: () => void;
  onScan: () => void;
  onEdit?: () => void;
}

export function CatalogFolderCard({ folder, onRemove, onScan, onEdit }: Props) {
  const folderName = folder.path.split(/[\\/]/).filter(Boolean).pop() || folder.path;
  const lastScan = folder.lastScanAt
    ? new Date(folder.lastScanAt * 1000).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '—';

  return (
    <div className={styles.folderCard}>
      <div className={styles.folderCardIcon}>
        <Folder size={16} />
      </div>
      <div className={styles.folderCardBody}>
        <span className={styles.folderCardName} title={folderName}>{folderName}</span>
        <span className={styles.folderCardPath} title={folder.path}>{folder.path}</span>
      </div>
      <div className={styles.folderCardCount}>
        <span className={styles.folderCardCountValue}>{folder.photoCount}</span>
        <span className={styles.folderCardCountLabel}>fotos</span>
      </div>
      <div className={styles.folderCardScan}>
        <span className={styles.folderCardScanValue}>{lastScan}</span>
      </div>
      <div className={styles.folderCardStatusWrap}>
        {folder.folderType === 'reference' && (
          <span className={`${styles.folderCardStatus} ${styles.folderCardStatusRef}`}>
            Referência
          </span>
        )}
        <span className={`${styles.folderCardStatus} ${styles.folderCardStatusActive}`}>
          {folder.status === 'active' ? '• Ativa' : folder.status}
        </span>
      </div>
      <div className={styles.folderCardActions}>
        <button className={styles.folderActionBtn} onClick={onScan} title="Escanear">
          <Play size={14} />
        </button>
        <button className={styles.folderActionBtn} onClick={onEdit} title="Editar" type="button">
          <PencilLine size={14} />
        </button>
        <button className={`${styles.folderActionBtn} ${styles.folderActionBtnDanger}`} onClick={onRemove} title="Remover" type="button">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
