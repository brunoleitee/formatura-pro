import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, Loader2 } from 'lucide-react';
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
  hasMoreBackend?: boolean;
  loadingMoreBackend?: boolean;
  onLoadMoreBackend?: () => void;
};

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const PAGE_SIZE = 100;
const GRID_GAP = 12;

const ZOOM_OPTIONS = [
  { label: 'Pequeno', value: 150 },
  { label: 'Médio', value: 190 },
  { label: 'Grande', value: 240 },
] as const;

function isFolderItem(item: CloudItem) {
  return item.mimeType === DRIVE_FOLDER_MIME || item.isFolder === true;
}

function isImageItem(item: CloudItem) {
  return !isFolderItem(item) && (item.isImage === true || /^image\//.test(item.mimeType));
}

function getColumns(width: number, cardSize: number) {
  return Math.max(1, Math.floor((Math.max(width, cardSize) + GRID_GAP) / (cardSize + GRID_GAP)));
}

function getRowStyle(start: number, height: number, columns: number, cardSize: number): CSSProperties {
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height,
    display: 'grid',
    gridTemplateColumns: `repeat(${columns}, minmax(0, ${cardSize}px))`,
    gap: GRID_GAP,
    transform: `translateY(${start}px)`,
    alignItems: 'stretch',
    contain: 'layout paint style',
  };
}

export function CloudExplorer({
  items,
  breadcrumb,
  loading,
  selectedFolderId,
  folderInsights = {},
  onOpenFolder,
  onSelectFolder,
  onGoToBreadcrumb,
  hasMoreBackend = false,
  loadingMoreBackend = false,
  onLoadMoreBackend,
}: CloudExplorerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadTimerRef = useRef<number | null>(null);
  const loadingMoreRef = useRef(false);
  const [zoom, setZoom] = useState(190);
  const [containerWidth, setContainerWidth] = useState(0);
  const [visiblePhotoCount, setVisiblePhotoCount] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);

  const folders = useMemo(() => items.filter(isFolderItem), [items]);
  const photos = useMemo(() => items.filter(isImageItem), [items]);
  const photoCount = photos.length;
  const folderCount = folders.length;
  const visiblePhotos = photos.slice(0, Math.min(visiblePhotoCount, photoCount));
  const hasMorePhotos = visiblePhotos.length < photoCount;
  const columns = getColumns(containerWidth || 960, zoom);
  const rowHeight = Math.round(zoom * 0.78) + 72;
  const rowCount = Math.ceil(visiblePhotos.length / columns);
  const totalHeight = Math.max(0, rowCount * rowHeight + Math.max(0, rowCount - 1) * GRID_GAP);
  const displayedEnd = visiblePhotos.length;

  useEffect(() => {
    setVisiblePhotoCount(PAGE_SIZE);
    setLoadingMore(false);
    loadingMoreRef.current = false;
    if (loadTimerRef.current) {
      window.clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
    }
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [breadcrumb, items]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const updateWidth = () => setContainerWidth(el.clientWidth);
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const loadMorePhotos = useCallback(() => {
    if (loadingMoreRef.current || !hasMorePhotos) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    loadTimerRef.current = window.setTimeout(() => {
      setVisiblePhotoCount(count => Math.min(count + PAGE_SIZE, photoCount));
      setLoadingMore(false);
      loadingMoreRef.current = false;
      loadTimerRef.current = null;
    }, 120);
  }, [hasMorePhotos, photoCount]);

  useEffect(() => {
    return () => {
      if (loadTimerRef.current) {
        window.clearTimeout(loadTimerRef.current);
      }
      loadingMoreRef.current = false;
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || (!hasMorePhotos && !hasMoreBackend)) return;

    const onScroll = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 900) {
        if (hasMorePhotos) {
          loadMorePhotos();
        } else if (hasMoreBackend && onLoadMoreBackend && !loadingMoreBackend) {
          onLoadMoreBackend();
        }
      }
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [hasMorePhotos, loadMorePhotos, hasMoreBackend, loadingMoreBackend, onLoadMoreBackend]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || loading || loadingMore || loadingMoreBackend || (!hasMorePhotos && !hasMoreBackend)) return;
    if (el.scrollHeight <= el.clientHeight + 80) {
      if (hasMorePhotos) {
        loadMorePhotos();
      } else if (hasMoreBackend && onLoadMoreBackend) {
        onLoadMoreBackend();
      }
    }
  }, [hasMorePhotos, loadMorePhotos, loading, loadingMore, loadingMoreBackend, hasMoreBackend, onLoadMoreBackend, visiblePhotos.length, totalHeight]);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight + GRID_GAP,
    overscan: 4,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [columns, rowHeight, rowVirtualizer]);

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
          {photoCount > 0 && (
            <span><strong>1-{displayedEnd}</strong> de {photoCount}</span>
          )}
        </div>
        <div className={styles.zoomControl} aria-label="Zoom do grid de fotos">
          {ZOOM_OPTIONS.map(option => (
            <button
              key={option.value}
              type="button"
              data-active={zoom === option.value}
              onClick={() => setZoom(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={scrollRef} className={styles.explorerScroll}>
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
                <div className={styles.photoSectionHeader}>
                  <div className={styles.sectionLabel}>Fotos</div>
                  <span>Exibindo 1-{displayedEnd} de {photoCount}</span>
                </div>
                <div
                  className={styles.virtualPhotoGrid}
                  style={{ height: totalHeight }}
                >
                  {rowVirtualizer.getVirtualItems().map(row => {
                    const start = row.index * columns;
                    const rowPhotos = visiblePhotos.slice(start, Math.min(start + columns, visiblePhotos.length));

                    return (
                      <div
                        key={row.key}
                        style={getRowStyle(row.start, rowHeight, columns, zoom)}
                      >
                        {rowPhotos.map(photo => (
                          <CloudPhotoCard key={photo.id} photo={photo} />
                        ))}
                      </div>
                    );
                  })}
                </div>

                {(loadingMore || loadingMoreBackend) && (
                  <div className={styles.loadingMore}>
                    <Loader2 size={16} className={styles.spin} />
                    Carregando mais fotos...
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
