import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Image as ImageIcon } from 'lucide-react';
import type { MouseEvent, PointerEvent } from 'react';
import type { Photo } from '../../services/api';
import { MemoPhotoCard } from './PhotoCard';
import { getPhotoId } from '../../hooks/usePhotoSelection';

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
  const [viewportWidth, setViewportWidth] = useState(0);

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

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowVirtualizer, cardWidth, thumbHeight, cardHeight, columns]);

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
                const eager = globalIndex < Math.max(12, columns * 2);

                return (
                  <MemoPhotoCard
                    key={id}
                    photo={photo}
                    isSelected={selectedPaths.has(id)}
                    getSelectionCount={getSelectionCount}
                    cardWidth={cardWidth}
                    thumbHeight={thumbHeight}
                    cardHeight={cardHeight}
                    imgLoading={eager ? 'eager' : 'lazy'}
                    imgFetchPriority={eager ? 'high' : 'low'}
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
