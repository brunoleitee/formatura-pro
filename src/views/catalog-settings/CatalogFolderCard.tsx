import { memo } from 'react';
import { Play, Trash2, Power } from 'lucide-react';
import type { CatalogFolder } from '../../services/api';
import styles from '../CatalogSettingsView.module.css';
import folderIcon from '../../assets/folder.svg';

interface Props {
  folder: CatalogFolder;
  onRemove: (folder: CatalogFolder) => void;
  onScan: (folder: CatalogFolder) => void;
  onToggle?: (folder: CatalogFolder) => void;
}

export const CatalogFolderCard = memo(function CatalogFolderCard({ folder, onRemove, onScan, onToggle }: Props) {
  const isActive = folder.status === 'active';
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
    <div className={`${styles.folderCard} ${!isActive ? styles.folderCardInactive : ''}`}>
      <div className={`${styles.folderCardIcon} ${!isActive ? styles.folderCardIconInactive : ''}`}>
        <img src={folderIcon} alt="" aria-hidden="true" className={styles.folderCardIconImage} />
      </div>
      <div className={styles.folderCardBody}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span className={styles.folderCardName} title={folderName}>{folderName}</span>
          {folder.includeSubfolders && (
            <span className={styles.subfoldersTag}>subpastas</span>
          )}
        </div>
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
        <span className={`${styles.folderCardStatus} ${isActive ? styles.folderCardStatusActive : styles.folderCardStatusInactive}`}>
          {isActive ? '• Ativa' : '• Inativa'}
        </span>
      </div>
      <div className={styles.folderCardActions}>
        <button className={styles.folderActionBtn} onClick={() => onScan(folder)} title="Escanear">
          <Play size={14} />
        </button>
        <button
          className={`${styles.folderActionBtn} ${!isActive ? styles.folderActionBtnToggleOff : ''}`}
          onClick={() => onToggle?.(folder)}
          title={isActive ? 'Desativar pasta' : 'Ativar pasta'}
          type="button"
        >
          <Power size={14} />
        </button>
        <button className={`${styles.folderActionBtn} ${styles.folderActionBtnDanger}`} onClick={() => onRemove(folder)} title="Remover" type="button">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
});
