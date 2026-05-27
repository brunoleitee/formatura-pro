import { memo } from 'react';
import { Folder, X, Check, Eye } from 'lucide-react';
import styles from '../../views/ScannerWorkspace.module.css';

const HIDDEN_DIRS = new Set(['.cache', '.temp', '__pycache__', 'thumbs', 'thumbnails']);

interface Props {
  path: string;
  statuses: Record<string, 'include' | 'ignore' | 'monitor'>;
  onStatusChange: (subPath: string, status: 'include' | 'ignore' | 'monitor') => void;
  onRemove: () => void;
}

const EventFolderItem = memo(function EventFolderItem({ path: folderPath, statuses, onStatusChange, onRemove }: Props) {
  const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath;
  const entries = Object.entries(statuses).filter(([k]) => !HIDDEN_DIRS.has(k.toLowerCase().split('/').pop() || ''));
  const included = entries.filter(([, v]) => v === 'include').length;
  const ignored = entries.filter(([, v]) => v === 'ignore').length;

  return (
    <div className={styles.eventFolderCard}>
      <div className={styles.eventFolderHeader}>
        <Folder size={12} className={styles.eventFolderIcon} />
        <span className={styles.eventFolderName}>{folderName}</span>
        <span className={styles.eventFolderCount}>{entries.length} subpastas</span>
        <button className={styles.eventFolderRemove} onClick={onRemove} title="Remover pasta">
          <X size={10} />
        </button>
      </div>
      <div className={styles.eventFolderSubList}>
        {entries.map(([subPath, status]) => (
          <div key={subPath} className={styles.eventFolderSubRow}>
            <span className={styles.eventFolderSubName}>{subPath}</span>
            <div className={styles.eventFolderSubActions}>
              {(['include', 'ignore', 'monitor'] as const).map(s => (
                <button
                  key={s}
                  className={`${styles.eventSubBtn} ${status === s ? styles[`eventSubBtn${s.charAt(0).toUpperCase() + s.slice(1)}`] : ''}`}
                  onClick={() => onStatusChange(subPath, s)}
                  title={s === 'include' ? 'Incluir' : s === 'ignore' ? 'Ignorar' : 'Monitorar'}
                >
                  {s === 'include' ? <Check size={10} /> : s === 'ignore' ? <X size={10} /> : <Eye size={10} />}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className={styles.eventFolderFooter}>
        <Check size={10} className={styles.eventFolderFooterIcon} />
        <span>{included} incluídas</span>
        {ignored > 0 && <><X size={10} className={styles.eventFolderFooterIcon} /><span>{ignored} ignoradas</span></>}
      </div>
    </div>
  );
});

export default EventFolderItem;
