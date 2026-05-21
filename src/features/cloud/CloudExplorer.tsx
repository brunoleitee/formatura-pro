import { ChevronRight } from 'lucide-react';
import { CloudFolderCard } from './CloudFolderCard';
import type { CloudFolderInsight, CloudItem } from './types';
import styles from '../../views/CloudView.module.css';

type BreadcrumbItem = {
  id: string;
  name: string;
};

type CloudExplorerProps = {
  items: CloudItem[];
  breadcrumb: BreadcrumbItem[];
  loading: boolean;
  selectedFolderId?: string;
  folderInsights?: Record<string, CloudFolderInsight>;
  showFolderMetadata: boolean;
  onOpenFolder: (item: CloudItem) => void;
  onSelectFolder: (item: CloudItem) => void;
  onGoToBreadcrumb: (index: number) => void;
};

export function CloudExplorer({
  items,
  breadcrumb,
  loading,
  selectedFolderId,
  folderInsights = {},
  showFolderMetadata,
  onOpenFolder,
  onSelectFolder,
  onGoToBreadcrumb,
}: CloudExplorerProps) {
  const folders = items.filter(item => item.isFolder);

  return (
    <section className={styles.explorerPanel}>
      <div className={styles.explorerToolbar}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          {breadcrumb.map((item, index) => (
            <button
              key={`${item.id}-${index}`}
              type="button"
              onClick={() => onGoToBreadcrumb(index)}
              className={index === breadcrumb.length - 1 ? styles.breadcrumbCurrent : undefined}
            >
              {item.name}
              {index < breadcrumb.length - 1 && <ChevronRight size={13} />}
            </button>
          ))}
        </nav>
      </div>

      {loading ? (
        <div className={styles.emptyPanel}>Carregando pastas do Google Drive...</div>
      ) : folders.length === 0 ? (
        <div className={styles.emptyPanel}>Nenhuma pasta encontrada neste nível.</div>
      ) : (
        <div className={styles.folderGrid}>
          {folders.map(folder => (
            <CloudFolderCard
              key={folder.id}
              folder={folder}
              insight={folderInsights[folder.id]}
              selected={selectedFolderId === folder.id}
              showMetadata={showFolderMetadata}
              onOpenFolder={onOpenFolder}
              onSelectFolder={onSelectFolder}
            />
          ))}
        </div>
      )}
    </section>
  );
}
