import { ChevronRight } from 'lucide-react';
import { CloudFolderCard } from './CloudFolderCard';
import { CloudPhotoCard } from './CloudPhotoCard';
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
  onOpenFolder,
  onSelectFolder,
  onGoToBreadcrumb,
}: CloudExplorerProps) {
  const folders = items.filter(item => item.mimeType === 'application/vnd.google-apps.folder' || item.isFolder);
  const photos = items.filter(item => item.isImage || /^image\//.test(item.mimeType));
  const photoCount = photos.length;
  const folderCount = folders.length;

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
        <div className={styles.explorerStats}>
          <span><strong>{folderCount}</strong> pastas</span>
          <span><strong>{photoCount}</strong> fotos</span>
        </div>
      </div>

      {loading ? (
        <div className={styles.emptyPanel}>Carregando pastas do Google Drive...</div>
      ) : items.length === 0 ? (
        <div className={styles.emptyPanel}>Nenhum item encontrado nesta pasta.</div>
      ) : (
        <>
          {folders.length > 0 && (
            <>
              <div className={styles.sectionLabel}>Subpastas</div>
            <div className={styles.folderGrid}>
              {folders.map(folder => (
                <CloudFolderCard
                  key={folder.id}
                  folder={folder}
                  insight={folderInsights[folder.id]}
                  selected={selectedFolderId === folder.id}
                  onOpenFolder={onOpenFolder}
                  onSelectFolder={onSelectFolder}
                />
              ))}
            </div>
            </>
          )}

          {photos.length > 0 && (
            <>
              <div className={styles.sectionLabel}>Fotos</div>
            <div className={styles.photoGrid}>
              {photos.map(photo => (
                <CloudPhotoCard key={photo.id} photo={photo} />
              ))}
            </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
