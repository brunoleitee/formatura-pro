import { Folder, RefreshCw, Trash2 } from 'lucide-react';
import type { CatalogFolder } from '../../services/api';
import styles from '../CatalogSettingsView.module.css';

interface Props {
  folder: CatalogFolder;
  onRemove: () => void;
  onScan: () => void;
}

export function CatalogFolderCard({ folder, onRemove, onScan }: Props) {
  const folderName = folder.path.split(/[\\/]/).filter(Boolean).pop() || folder.path;
  const lastScan = folder.lastScanAt
    ? new Date(folder.lastScanAt * 1000).toLocaleString()
    : '—';

  return (
    <div className={styles.folderCard}>
      <div className={styles.folderCardIcon}>
        <Folder size={16} />
      </div>
      <div className={styles.folderCardBody}>
        <span className={styles.folderCardPath} title={folder.path}>{folder.path}</span>
        <div className={styles.folderCardMeta}>
          <span>{folder.photoCount} fotos</span>
          <span>Último scan: {lastScan}</span>
          <span className={`${styles.folderCardStatus} ${styles.folderCardStatusActive}`}>
            {folder.status === 'active' ? 'Ativa' : folder.status}
          </span>
        </div>
      </div>
      <div className={styles.folderCardActions}>
        <button className={styles.folderActionBtn} onClick={onScan} title="Reescanear">
          <RefreshCw size={12} />
        </button>
        <button className={`${styles.folderActionBtn} ${styles.folderActionBtnDanger}`} onClick={onRemove} title="Remover">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
