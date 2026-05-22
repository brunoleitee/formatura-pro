import { Check, Folder, FolderOpen } from 'lucide-react';
import type { CloudFolderInsight, CloudItem } from './types';
import { detectReferenceFolders } from './detectReferenceFolders';
import styles from '../../views/CloudView.module.css';

type CloudFolderCardProps = {
  folder: CloudItem;
  insight?: CloudFolderInsight;
  selected: boolean;
  onOpenFolder: (folder: CloudItem) => void;
  onSelectFolder: (folder: CloudItem) => void;
};

function formatCount(count?: number) {
  if (typeof count !== 'number') return null;
  return new Intl.NumberFormat('pt-BR').format(count);
}

export function CloudFolderCard({
  folder,
  insight,
  selected,
  onOpenFolder,
  onSelectFolder,
}: CloudFolderCardProps) {
  const photoLabel = formatCount(insight?.photoCount ?? folder.photoCount);
  const subfolderLabel = formatCount(insight?.subfolderCount ?? folder.subfolderCount);
  
  const isReferenceFolder = detectReferenceFolders([folder]).length > 0;
  const isReferenceDetected = isReferenceFolder;
  const referencesCount = isReferenceFolder ? 1 : 0;

  return (
    <article className={styles.folderCard} data-selected={selected}>
      <button
        type="button"
        className={styles.folderSelectArea}
        onClick={() => onSelectFolder(folder)}
        title={`Selecionar ${folder.name}`}
      >
        <div className={styles.folderHeader}>
          <span className={styles.folderIconWrap} aria-hidden="true">
            <Folder size={20} />
          </span>
          <span className={styles.folderName} title={folder.name}>{folder.name}</span>
          {selected && <Check size={16} className={styles.folderSelectedMark} />}
        </div>

        <div className={styles.folderStats}>
          <div className={styles.statItem}>
            <span className={styles.statCount}>{photoLabel ?? '0'}</span>
            <span className={styles.statLabel}>fotos</span>
          </div>
          <div className={styles.statItem}>
            <span className={styles.statCount}>{subfolderLabel ?? '0'}</span>
            <span className={styles.statLabel}>subpastas</span>
          </div>
        </div>

        {isReferenceDetected && (
          <div className={styles.referenceBadgeContainer}>
            <span className={styles.referenceBadge}>
              {referencesCount && referencesCount > 1 ? `${referencesCount} referências` : 'Referência detectada'}
            </span>
          </div>
        )}
      </button>

      <button
        type="button"
        className={styles.openFolderButtonCentered}
        onClick={(e) => {
          e.stopPropagation();
          onOpenFolder(folder);
        }}
        title={`Abrir ${folder.name}`}
      >
        <FolderOpen size={14} />
        Abrir
      </button>
    </article>
  );
}
