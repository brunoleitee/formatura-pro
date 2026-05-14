import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Image as ImageIcon } from 'lucide-react';
import type { MouseEvent, PointerEvent } from 'react';
import { api, type Photo } from '../../services/api';
import { MemoPhotoCard } from './PhotoCard';
import { getPhotoId } from '../../hooks/usePhotoSelection';
import { aiCacheStore } from '../../services/AICacheStore';
import { aiQueueManager } from '../../services/AIQueueManager';
import { aiApi } from '../../services/aiApi';
import { ratingCache } from '../../services/RatingCache';

interface VirtualizedPhotoGridProps {
  photos: Photo[];
  selectedPaths: Set<string>;
  getSelectionCount?: () => number;
  onPhotoClick: (photo: Photo, event: MouseEvent) => void;
  onDoubleClick?: (photo: Photo) => void;
  onOpenDetails: (photo: Photo) => void;
  onDragStart?: (photo: Photo, event: PointerEvent) => void;
  onDragEnd?: (photo: Photo, event: PointerEvent) => void;
  onFirstThumbLoad?: () => void;
  zoom?: number;
  resetScrollKey?: string;
}

const GRID_GAP = 10;
const MIN_COL_WIDTH = 140;
const CARD_INFO_HEIGHT = 72;

function getColumnsByZoom(zoom: number) {
  if (zoom >= 300) return 2;
  if (zoom >= 260) return 3;
  if (zoom >= 220) return 4;
  if (zoom >= 180) return 5;
  if (zoom >= 140) return 6;
  return 8;
}

function getThumbSizeForCard(cardWidth: number) {
  if (cardWidth >= 700) return 1200;
  if (cardWidth >= 500) return 1000;
  if (cardWidth >= 350) return 800;
  return 400;
}

function getLowThumbSizeForCard(cardWidth: number) {
  return cardWidth >= 500 ? 600 : 400;
}

export const VirtualizedPhotoGrid = memo(function VirtualizedPhotoGrid({
  photos,
  selectedPaths,
  getSelectionCount,
  onPhotoClick,
  onDoubleClick,
  onOpenDetails,
  onDragStart,
  onDragEnd,
  onFirstThumbLoad,
  zoom = 180,
  resetScrollKey,
}: VirtualizedPhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(() => 
    typeof window !== 'undefined' ? window.innerWidth - 320 : 0
  );
  const perfEnabled = typeof window !== 'undefined' && window.localStorage.getItem('formaturapro:perf') === '1';

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const updateWidth = () => {
      setViewportWidth(el.clientWidth);
    };

    updateWidth();

    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!parentRef.current) return;
    parentRef.current.scrollTop = 0;
  }, [resetScrollKey]);

  useEffect(() => {
    const limited = photos.slice(0, 50);
    const paths = limited.map((p) => p.path).filter(Boolean) as string[];
    if (paths.length === 0) return;
    let cancelled = false;

    api.getRatings(paths).then((res) => {
      if (!cancelled) ratingCache.loadBatch(res.items);
    }).catch(() => {});
    console.log(`[AI-GRID] batch status solicitado (${paths.length} fotos)`);
    aiApi.batchStatus(paths).then((res) => {
      if (cancelled) return;
      let found = 0;
      for (const item of res.items) {
        if (item.status === "completed") {
          aiCacheStore.set(item.foto_path, {
            face_detected: item.face_detected ?? false,
            faces_count: item.faces_count ?? 0,
            embedding_ready: item.embedding_ready ?? false,
            final_student: item.final_student ?? null,
            status: "completed",
          });
          found++;
        }
      }
      console.log(`[AI-GRID] cache preenchido: ${found}`);
      const pending = paths.filter((p) => {
        const c = aiCacheStore.get(p);
        return !c || c.status !== "completed";
      });
      if (pending.length > 0) {
        console.log(`[AI-GRID] queue pendente: ${pending.length}`);
        aiQueueManager.batchInitialize(pending);
      }
    }).catch(() => {
      if (!cancelled) aiQueueManager.batchInitialize(paths);
    });
    return () => { cancelled = true; };
  }, []);

  const columns = useMemo(() => {
    const safeWidth = Math.max(0, viewportWidth);
    const widthCap = Math.max(2, Math.floor((safeWidth + GRID_GAP) / (MIN_COL_WIDTH + GRID_GAP)));
    const zoomTarget = getColumnsByZoom(zoom);
    return zoom >= 300 ? 2 : Math.max(2, Math.min(zoomTarget, widthCap));
  }, [viewportWidth, zoom]);

  const cardWidth = useMemo(() => {
    const safeWidth = Math.max(0, viewportWidth);
    const availableWidth = Math.max(0, safeWidth - GRID_GAP * Math.max(0, columns - 1));
    return Math.max(MIN_COL_WIDTH, Math.floor(availableWidth / columns));
  }, [viewportWidth, columns]);
  const thumbHeight = useMemo(() => Math.max(120, Math.round(cardWidth * 0.66)), [cardWidth]);
  const cardHeight = useMemo(() => thumbHeight + CARD_INFO_HEIGHT, [thumbHeight]);
  const thumbSize = useMemo(() => getThumbSizeForCard(cardWidth), [cardWidth]);
  const thumbLowSize = useMemo(() => getLowThumbSizeForCard(cardWidth), [cardWidth]);
  const rowCount = useMemo(() => Math.ceil(photos.length / columns), [photos.length, columns]);
  const totalRowsSize = useMemo(() => {
    if (rowCount === 0) return 0;
    return rowCount * cardHeight + Math.max(0, rowCount - 1) * GRID_GAP;
  }, [rowCount, cardHeight]);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => cardHeight + GRID_GAP,
    overscan: 6,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const renderedCards = useMemo(() => {
    return virtualRows.reduce((count, virtualRow) => {
      const startIndex = virtualRow.index * columns;
      const endIndex = Math.min(startIndex + columns, photos.length);
      return count + Math.max(0, endIndex - startIndex);
    }, 0);
  }, [virtualRows, columns, photos.length]);

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowVirtualizer, cardWidth, thumbHeight, cardHeight, columns]);

  useEffect(() => {
    if (!perfEnabled) return;
    // eslint-disable-next-line no-console
    console.debug('[formaturapro][catalog-grid]', {
      totalPhotos: photos.length,
      columns,
      cardHeight,
      overscan: 6,
      virtualRows: virtualRows.length,
      renderedCards,
    });
  }, [perfEnabled, photos.length, columns, cardHeight, virtualRows.length, renderedCards]);

  if (photos.length === 0) {
    return (
      <div className="empty-state">
        <ImageIcon size={48} opacity={0.3} />
        <h3>Nenhuma foto encontrada</h3>
        <p>Use "Escanear Pasta" na barra superior para adicionar fotos.</p>
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        position: 'relative',
        paddingBottom: '20px',
        contain: 'layout paint',
      }}
    >
      <div style={{ height: totalRowsSize, position: 'relative' }}>
        {virtualRows.map((virtualRow) => {
          const startIndex = virtualRow.index * columns;
          const endIndex = Math.min(startIndex + columns, photos.length);
          const rowPhotos = photos.slice(startIndex, endIndex);

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
                height: `${cardHeight}px`,
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, ${cardWidth}px)`,
                gap: `${GRID_GAP}px`,
                alignItems: 'stretch',
                justifyContent: 'start',
              }}
            >
              {rowPhotos.map((photo, localIndex) => {
                const id = getPhotoId(photo);
                const globalIndex = startIndex + localIndex;
                const eager = true;
                const highPriority = globalIndex < Math.max(12, columns * 2);

                return (
                  <MemoPhotoCard
                    key={id}
                    photo={photo}
                    isSelected={selectedPaths.has(id)}
                    getSelectionCount={getSelectionCount}
                    cardWidth={cardWidth}
                    thumbHeight={thumbHeight}
                    cardHeight={cardHeight}
                    thumbTargetSize={thumbSize}
                    thumbLowTargetSize={thumbLowSize}
                    imgLoading={eager ? 'eager' : 'lazy'}
                    imgFetchPriority={highPriority ? 'high' : 'low'}
                    onClick={onPhotoClick}
                    onDoubleClick={onDoubleClick}
                    onOpenDetails={onOpenDetails}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    onFirstThumbLoad={onFirstThumbLoad}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
});
