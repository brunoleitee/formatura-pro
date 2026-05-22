import { Check, Folder, FolderOpen, FolderTree } from 'lucide-react';
import type { CloudFolderInsight, CloudItem } from './types';
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
  const photoLabel = formatCount(insight?.photoCount);
  const subfolderLabel = formatCount(insight?.subfolderCount);

  return (
    <article className={styles.folderCard} data-selected={selected}>
      <button
        type="button"
        className={styles.folderSelect}
        onClick={() => onSelectFolder(folder)}
        title={`Selecionar ${folder.name}`}
      >
        <span className={styles.folderIconWrap} aria-hidden="true">
          <Folder size={20} />
        </span>
        <span className={styles.folderText}>
          <span className={styles.folderName}>{folder.name}</span>
          <span className={styles.folderStats}>
            {photoLabel ? <span><FolderTree size={12} />{photoLabel} fotos</span> : null}
            {subfolderLabel ? <span><FolderTree size={12} />{subfolderLabel} subpastas</span> : null}
            {!photoLabel && !subfolderLabel ? <span><FolderTree size={12} />Sem contagem disponível</span> : null}
          </span>
        </span>
        {selected && <Check size={12} className={styles.folderSelectedMark} />}
      </button>

      <button
        type="button"
        className={styles.openFolderButton}
        onClick={() => onOpenFolder(folder)}
        title={`Abrir ${folder.name}`}
      >
        <FolderOpen size={14} />
        Abrir
      </button>
    </article>
  );
}
