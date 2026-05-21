import { Check, Folder, FolderOpen } from 'lucide-react';
import { detectReferenceFolders } from './detectReferenceFolders';
import type { CloudFolderInsight, CloudItem } from './types';
import styles from '../../views/CloudView.module.css';

type CloudFolderCardProps = {
  folder: CloudItem;
  insight?: CloudFolderInsight;
  selected: boolean;
  onOpenFolder: (folder: CloudItem) => void;
  onSelectFolder: (folder: CloudItem) => void;
};

export function CloudFolderCard({
  folder,
  insight,
  selected,
  onOpenFolder,
  onSelectFolder,
}: CloudFolderCardProps) {
  const isReference = insight?.referenceDetected || detectReferenceFolders([folder]).length > 0;

  return (
    <article className={styles.folderCard} data-selected={selected}>
      <button
        type="button"
        className={styles.folderSelect}
        onClick={() => onSelectFolder(folder)}
        title={`Selecionar ${folder.name}`}
      >
        <Folder size={18} />
        <span>{folder.name}</span>
        {selected && <Check size={15} />}
      </button>
      <div className={styles.folderMeta}>
        <span>{typeof insight?.photoCount === 'number' ? `${insight.photoCount} fotos` : 'fotos pendentes'}</span>
        <span>{typeof insight?.subfolderCount === 'number' ? `${insight.subfolderCount} subpastas` : 'subpastas'}</span>
        {isReference && <strong>Referência detectada</strong>}
      </div>
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
