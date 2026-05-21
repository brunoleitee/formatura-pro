import { Check, ChevronRight, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { detectReferenceFolders } from './detectReferenceFolders';
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
  onRefresh: () => void;
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
  onRefresh,
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
        <button type="button" className={styles.secondaryButton} onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} className={loading ? styles.spin : undefined} />
          Atualizar
        </button>
      </div>

      {loading ? (
        <div className={styles.emptyPanel}>Carregando pastas do Google Drive...</div>
      ) : folders.length === 0 ? (
        <div className={styles.emptyPanel}>Nenhuma pasta encontrada neste nível.</div>
      ) : (
        <div className={styles.folderGrid}>
          {folders.map(folder => {
            const selected = selectedFolderId === folder.id;
            const insight = folderInsights[folder.id];
            const isReference = insight?.referenceDetected || detectReferenceFolders([folder]).length > 0;
            return (
              <article className={styles.folderCard} key={folder.id} data-selected={selected}>
                <button
                  type="button"
                  className={styles.folderSelect}
                  onClick={() => onSelectFolder(folder)}
                  title={`Selecionar ${folder.name}`}
                >
                  <Folder size={22} />
                  <span>{folder.name}</span>
                  {selected && <Check size={16} />}
                </button>
                <div className={styles.folderMeta}>
                  {typeof insight?.photoCount === 'number' && <span>{insight.photoCount} fotos</span>}
                  {typeof insight?.subfolderCount === 'number' && <span>{insight.subfolderCount} subpastas</span>}
                  {isReference && <strong>Referência detectada</strong>}
                  {!insight && !isReference && <span>Pasta</span>}
                </div>
                <button
                  type="button"
                  className={styles.openFolderButton}
                  onClick={() => onOpenFolder(folder)}
                  title={`Abrir ${folder.name}`}
                >
                  <FolderOpen size={15} />
                  Abrir
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
