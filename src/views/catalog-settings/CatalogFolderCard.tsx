import { Folder, RefreshCw, Edit3, Trash2 } from 'lucide-react';
import styles from '../CatalogSettingsView.module.css';

interface Props {
  path: string;
}

export function CatalogFolderCard({ path }: Props) {
  const folderName = path.split(/[\\/]/).filter(Boolean).pop() || path;

  return (
    <div className={styles.folderCard}>
      <div className={styles.folderCardIcon}>
        <Folder size={16} />
      </div>
      <div className={styles.folderCardBody}>
        <span className={styles.folderCardPath} title={path}>{path}</span>
        <div className={styles.folderCardMeta}>
          <span>0 fotos</span>
          <span>—</span>
          <span className={`${styles.folderCardStatus} ${styles.folderCardStatusActive}`}>Ativa</span>
        </div>
      </div>
      <div className={styles.folderCardActions}>
        <button className={styles.folderActionBtn} title="Reescanear">
          <RefreshCw size={12} />
        </button>
        <button className={styles.folderActionBtn} title="Editar">
          <Edit3 size={12} />
        </button>
        <button className={`${styles.folderActionBtn} ${styles.folderActionBtnDanger}`} title="Remover">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
