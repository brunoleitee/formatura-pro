import { memo, useCallback, useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Image as ImageIcon, RefreshCw } from 'lucide-react';
import type { MouseEvent, PointerEvent } from 'react';
import { api, type Photo } from '../../services/api';
import { MemoPhotoCard } from './PhotoCard';
import { getPhotoId } from '../../hooks/usePhotoSelection';
import { aiQueueManager } from '../../services/AIQueueManager';
import { aiApi } from '../../services/aiApi';
import { aiCacheStore } from '../../services/AICacheStore';
import { thumbManager } from '../../services/ThumbRequestManager';

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
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  zoom?: number;
  resetScrollKey?: string;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

const GRID_GAP = 10;
const MIN_COL_WIDTH = 140;
const ESTIMATED_CARD_HEIGHT = 400;
const OVERSCAN_STILL = 3;
const OVERSCAN_SCROLLING = 1;

function getColumnsByZoom(zoom: number) {
  if (zoom >= 300) return 2;
  if (zoom >= 260) return 3;
  if (zoom >= 220) return 4;
  if (zoom >= 180) return 5;
  if (zoom >= 140) return 6;
  return 8;
}

function columnsFromWidth(w: number, zoom: number) {
  const widthCap = Math.max(2, Math.floor((w + GRID_GAP) / (MIN_COL_WIDTH + GRID_GAP)));
  const zoomTarget = getColumnsByZoom(zoom);
  return zoom >= 300 ? 2 : Math.max(2, Math.min(zoomTarget, widthCap));
}

function cardWidthFromSize(w: number, cols: number) {
  const available = Math.max(0, w - GRID_GAP * Math.max(0, cols - 1));
  return Math.max(MIN_COL_WIDTH, Math.floor(available / cols));
}

function thumbSizeForCard(w: number) {
  if (w >= 350) return 320;
  if (w >= 250) return 240;
  return 200;
}

function getRowStyle(y: number, h: number, cols: number, cw: number): React.CSSProperties {
  return {
    position: 'absolute', top: 0, left: 0, width: '100%',
    transform: `translateY(${y}px)`,
    height: `${h}px`,
    display: 'grid',
    gridTemplateColumns: `repeat(${cols}, ${cw}px)`,
    gap: `${GRID_GAP}px`,
    alignItems: 'stretch', justifyContent: 'start',
    willChange: 'transform',
    contain: 'layout paint style',
    contentVisibility: 'auto',
  } as const;
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
  onLoadMore,
  hasMore,
  loadingMore,
  zoom = 180,
  resetScrollKey,
  scrollRef,
}: VirtualizedPhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const metricsRef = useRef({ w: 0, cols: 4, cw: 240, th: 400, sz: 200, rows: 0, totalH: 0 });
  const selRef = useRef(selectedPaths);
  selRef.current = selectedPaths;

  useEffect(() => {
    if (!scrollRef) return;
    (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = parentRef.current;
  });

  // --- viewport width (debounced) ---
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const w = el.clientWidth;
        const cols = columnsFromWidth(w, zoom);
        const cw = cardWidthFromSize(w, cols);
        const sz = thumbSizeForCard(cw);
        const imageHeight = Math.max(200, Math.min(Math.round(cw * 1.33), 500));
        const th = imageHeight + 72;
        const rows = Math.ceil(photos.length / cols);
        const totalH = rows * th + Math.max(0, rows - 1) * GRID_GAP;
        const m = metricsRef.current;
        const changed = m.w !== w || m.cols !== cols || m.cw !== cw;
        metricsRef.current = { w, cols, cw, th, sz, rows, totalH };
        if (changed) rowVirtualizer.measure();
      }, 80);
    };
    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, [photos.length, zoom]);

  // --- reset scroll ---
  useEffect(() => {
    if (parentRef.current) parentRef.current.scrollTop = 0;
  }, [resetScrollKey]);

  // --- load-more trigger ---
  const isLoadingMoreRef = useRef(false);
  useEffect(() => { isLoadingMoreRef.current = !!loadingMore; }, [loadingMore]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el || !onLoadMore || !hasMore) return;
    const cb = () => {
      if (isLoadingMoreRef.current) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 800) onLoadMore();
    };
    el.addEventListener('scroll', cb, { passive: true });
    return () => el.removeEventListener('scroll', cb);
  }, [onLoadMore, hasMore]);

  // --- virtualizer ---
  const rowVirtualizer = useVirtualizer({
    count: Math.max(1, Math.ceil(photos.length / Math.max(1, metricsRef.current.cols))),
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_CARD_HEIGHT,
    overscan: OVERSCAN_STILL,
  });
  const vzRef = useRef(rowVirtualizer);
  vzRef.current = rowVirtualizer;

  const virtualItems = rowVirtualizer.getVirtualItems();
  const stableRowsRef = useRef(virtualItems);
  if (virtualItems.length > 0 && (stableRowsRef.current.length === 0 || virtualItems[0].index !== stableRowsRef.current[0].index)) {
    stableRowsRef.current = virtualItems;
  }
  const visibleRows = stableRowsRef.current;

  const m = metricsRef.current;
  const cols = m.cols || 4;
  const cw = m.cw || 240;
  const th = m.th || 158;
  const sz = m.sz || 240;

  // --- rAF scroll throttle ---
  const scrollStateRef = useRef({ y: 0, speed: 0 });
  const rAFPending = useRef(false);
  const isScrollingFastRef = useRef(false);
  const scrollStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overscanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onScrollFrame = useCallback(() => {
    rAFPending.current = false;
    const el = parentRef.current;
    if (!el) return;
    const s = scrollStateRef.current;
    const fast = s.speed > 1.5;
    const vz = vzRef.current;

    if (fast !== isScrollingFastRef.current) {
      isScrollingFastRef.current = fast;
      if (fast) {
        el.setAttribute('data-scrolling', 'fast');
        document.documentElement.classList.add('scrolling-fast');
        if (!aiQueueManager.isPaused()) aiQueueManager.pause('scrolling');
        vz.options.overscan = OVERSCAN_SCROLLING;
      }
    }

    if (scrollStopTimer.current) clearTimeout(scrollStopTimer.current);
    scrollStopTimer.current = setTimeout(() => {
      scrollStopTimer.current = null;
      isScrollingFastRef.current = false;
      el.removeAttribute('data-scrolling');
      document.documentElement.classList.remove('scrolling-fast');
      if (aiQueueManager.getPauseReason() === 'scrolling') aiQueueManager.resume('idle');
      vz.options.overscan = OVERSCAN_STILL;

      if (overscanTimer.current) clearTimeout(overscanTimer.current);
      overscanTimer.current = setTimeout(() => {
        overscanTimer.current = null;
        const set = new Set<string>();
        for (const path of visibleKeysRef.current.split(',').filter(Boolean)) {
          set.add(`thumb:${path}:${sz}`);
        }
        thumbManager.cancelOnlyFarAwayRequests(set);
      }, 150);
    }, 400);
  }, [sz]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const now = Date.now();
    const s = scrollStateRef.current;
    const prevY = s.y;
    const y = el.scrollTop;
    const dt = now - scrollTimeRef.current;
    scrollTimeRef.current = now;
    s.speed = dt > 0 ? Math.abs(y - prevY) / dt : 0;
    s.y = y;

    if (!rAFPending.current) {
      rAFPending.current = true;
      requestAnimationFrame(onScrollFrame);
    }
  }, [onScrollFrame]);

  const scrollTimeRef = useRef(Date.now());

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      if (scrollStopTimer.current) clearTimeout(scrollStopTimer.current);
      if (overscanTimer.current) clearTimeout(overscanTimer.current);
      document.documentElement.classList.remove('scrolling-fast');
    };
  }, [handleScroll]);

  // --- AI visible detection ---
  const visibleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAIKeyRef = useRef('');
  const visibleKeysRef = useRef('');

  useEffect(() => {
    if (visibleRows.length === 0 || !cols) return;
    const idxs: number[] = [];
    for (const vr of visibleRows) {
      const start = vr.index * cols;
      const end = Math.min(start + cols, photos.length);
      for (let i = start; i < end; i++) idxs.push(i);
    }
    for (let i = 0; i < idxs.length; i++) {
      for (let d = -4; d <= 4; d++) {
        const n = idxs[i] + d;
        if (n >= 0 && n < photos.length && !idxs.includes(n)) idxs.push(n);
      }
    }
    const paths: string[] = [];
    const thumbPaths: string[] = [];
    for (const idx of [...new Set(idxs)]) {
      const p = photos[idx];
      if (p?.path) { paths.push(p.path); thumbPaths.push(p.path); }
    }
    visibleKeysRef.current = thumbPaths.join(',');

    const key = paths.join('|');
    if (key === lastAIKeyRef.current) return;
    lastAIKeyRef.current = key;

    if (visibleTimerRef.current) clearTimeout(visibleTimerRef.current);
    visibleTimerRef.current = setTimeout(() => {
      // Nunca executar batch-status durante scroll ativo
      if (isScrollingFastRef.current) return;
      const pending = paths.filter((p) => {
        if (aiQueueManager.isProcessed(p)) return false;
        const c = aiCacheStore.get(p);
        return !c || c.status !== 'completed';
      });
      if (pending.length === 0) return;
      const first8 = pending.slice(0, 8);
      aiApi.batchStatus(first8).then((res) => {
        for (const item of res.items) {
          if (item.status === 'completed') {
            aiCacheStore.set(item.foto_path, { face_detected: item.face_detected ?? false, faces_count: item.faces_count ?? 0, embedding_ready: item.embedding_ready ?? false, final_student: item.final_student ?? null, status: 'completed' });
          }
        }
        const sp = first8.filter(p => { const c = aiCacheStore.get(p); return !c || c.status !== 'completed'; });
        if (sp.length > 0) aiQueueManager.batchInitialize(sp);
      }).catch(() => aiQueueManager.batchInitialize(first8));
    }, 250);
    return () => { if (visibleTimerRef.current) clearTimeout(visibleTimerRef.current); };
  }, [visibleRows, cols, photos]);

  // --- scan status poll ---
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const st = await api.getScanStatus();
        if (cancelled) return;
        if (st?.is_scanning) { if (!aiQueueManager.isPaused()) aiQueueManager.pause('scanning'); }
        else if (aiQueueManager.getPauseReason() === 'scanning') aiQueueManager.resume('scan_end');
      } catch { if (aiQueueManager.getPauseReason() === 'scanning') aiQueueManager.resume('scan_end'); }
    };
    const id = setInterval(poll, 5000);
    poll();
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // --- stable callbacks ---
  const cbRef = useRef({ onClick: onPhotoClick, onDoubleClick, onOpenDetails, onDragStart, onDragEnd, getSelectionCount, onFirstThumbLoad });
  cbRef.current.onClick = onPhotoClick;
  cbRef.current.onDoubleClick = onDoubleClick;
  cbRef.current.onOpenDetails = onOpenDetails;
  cbRef.current.onDragStart = onDragStart;
  cbRef.current.onDragEnd = onDragEnd;
  cbRef.current.getSelectionCount = getSelectionCount;
  cbRef.current.onFirstThumbLoad = onFirstThumbLoad;

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
      data-scroll-container="true"
      style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        position: 'relative', paddingBottom: '20px',
        contain: 'layout paint style',
      }}
    >
      <div style={{ height: m.totalH, position: 'relative' }}>
        {visibleRows.map((vr) => {
          const start = vr.index * cols;
          const end = Math.min(start + cols, photos.length);
          const rowPhotos = photos.slice(start, end);

          return (
            <div key={vr.key} style={getRowStyle(vr.start, th, cols, cw)}>
              {rowPhotos.map((photo, li) => {
                const id = getPhotoId(photo);
                return (
                  <MemoPhotoCard
                    key={id}
                    photo={photo}
                    isSelected={selRef.current.has(id)}
                    getSelectionCount={cbRef.current.getSelectionCount}
                    cardWidth={cw}
                    thumbHeight={th - 72}
                    cardHeight={th}
                    thumbTargetSize={sz}
                    imgLoading="eager"
                    imgFetchPriority={(start + li) < Math.max(12, cols * 2) ? 'high' : 'low'}
                    onClick={cbRef.current.onClick}
                    onDoubleClick={cbRef.current.onDoubleClick}
                    onOpenDetails={cbRef.current.onOpenDetails}
                    onDragStart={cbRef.current.onDragStart}
                    onDragEnd={cbRef.current.onDragEnd}
                    onFirstThumbLoad={cbRef.current.onFirstThumbLoad}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      {loadingMore && (
        <div style={{ textAlign: 'center', padding: '20px', color: '#888' }}>
          <RefreshCw size={20} className="spin" style={{ verticalAlign: 'middle', marginRight: 8 }} />
          Carregando mais fotos...
        </div>
      )}
    </div>
  );
});
