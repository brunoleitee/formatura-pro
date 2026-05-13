import React, { memo, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Image as ImageIcon, MoreHorizontal } from 'lucide-react';
import { api, type Photo } from '../../services/api';
import { isPhotoBlurry, isPhotoAttention } from '../../utils/qualityUtils';
import { isPhotoMapped, isKnownFace } from '../../utils/personIdentity';

interface PhotoCardProps {
  photo: Photo;
  isSelected: boolean;
  getSelectionCount?: () => number;
  cardWidth?: number;
  thumbHeight?: number;
  cardHeight?: number;
  thumbTargetSize?: number;
  thumbLowTargetSize?: number;
  imgLoading?: 'eager' | 'lazy';
  imgFetchPriority?: 'high' | 'low' | 'auto';
  onClick: (photo: Photo, event: React.MouseEvent) => void;
  onDoubleClick?: (photo: Photo) => void;
  onOpenDetails: (photo: Photo) => void;
  onDragStart?: (photo: Photo, event: React.PointerEvent) => void;
  onDragEnd?: (photo: Photo, event: React.PointerEvent) => void;
  onFirstThumbLoad?: () => void;
}

function renderFaceOverlay(face: Photo['faces'][number], thumbSize: { w: number, h: number }, photoWidth: number, photoHeight: number) {
  if (face.x1 == null || !photoWidth || !photoHeight) return null;

  const imgRatio = photoWidth / photoHeight;
  const containerRatio = thumbSize.w / thumbSize.h;

  let renderedW = thumbSize.w;
  let renderedH = thumbSize.h;

  if (imgRatio > containerRatio) {
    renderedH = thumbSize.w / imgRatio;
  } else {
    renderedW = thumbSize.h * imgRatio;
  }

  const offsetX = (thumbSize.w - renderedW) / 2;
  const offsetY = (thumbSize.h - renderedH) / 2;
  const isKnown = isKnownFace(face);

  const x1 = offsetX + (face.x1 / photoWidth) * renderedW;
  const y1 = offsetY + (face.y1 / photoHeight) * renderedH;
  const widthPx = ((face.x2 - face.x1) / photoWidth) * renderedW;
  const heightPx = ((face.y2 - face.y1) / photoHeight) * renderedH;
  const color = isKnown ? 'rgba(34, 197, 94, 0.8)' : 'rgba(255, 255, 255, 0.4)';

  return (
    <div
      key={face.rowid ?? `${face.x1}-${face.y1}-${face.x2}-${face.y2}`}
      style={{
        position: 'absolute',
        left: `${x1}px`,
        top: `${y1}px`,
        width: `${widthPx}px`,
        height: `${heightPx}px`,
        border: `1.5px solid ${color}`,
        borderRadius: '2px',
        pointerEvents: 'none',
        boxSizing: 'border-box',
        zIndex: 1,
        boxShadow: '0 0 0 1px rgba(0,0,0,0.2)'
      }}
    >
      {(face.is_foreground === 1 || (face.foreground_score && face.foreground_score >= 0.65)) && (
        <div style={{ position: 'absolute', top: '-20px', left: '-2px', background: '#10b981', color: 'white', fontSize: '10px', padding: '2px 4px', borderRadius: '4px', whiteSpace: 'nowrap' }}>
          1º plano
        </div>
      )}
      {(face.is_foreground === 0 || (face.foreground_score !== undefined && face.foreground_score !== null && face.foreground_score < 0.45)) && (
        <div style={{ position: 'absolute', top: '-20px', left: '-2px', background: '#f59e0b', color: 'white', fontSize: '10px', padding: '2px 4px', borderRadius: '4px', whiteSpace: 'nowrap' }}>
          2º plano {face.background_penalty_reason ? `(${face.background_penalty_reason})` : ''}
        </div>
      )}
    </div>
  );
}

const HIGH_HQ_CONCURRENCY = 4;
type HighQueueEntry = {
  url: string;
  img: HTMLImageElement | null;
  started: boolean;
  cancelled: boolean;
  onLoad: () => void;
  onError: () => void;
};

const highQueue: HighQueueEntry[] = [];
let activeHighLoads = 0;

function pumpHighQueue() {
  while (activeHighLoads < HIGH_HQ_CONCURRENCY && highQueue.length > 0) {
    const entry = highQueue.shift();
    if (!entry || entry.cancelled) continue;

    activeHighLoads += 1;
    entry.started = true;
    const img = new window.Image();
    entry.img = img;
    img.decoding = 'async';
    img.onload = () => {
      activeHighLoads = Math.max(0, activeHighLoads - 1);
      if (!entry.cancelled) entry.onLoad();
      pumpHighQueue();
    };
    img.onerror = () => {
      activeHighLoads = Math.max(0, activeHighLoads - 1);
      if (!entry.cancelled) entry.onError();
      pumpHighQueue();
    };
    img.src = entry.url;
  }
}

function enqueueHighQualityLoad(url: string, onLoad: () => void, onError: () => void) {
  const entry: HighQueueEntry = {
    url,
    img: null,
    started: false,
    cancelled: false,
    onLoad,
    onError,
  };

  highQueue.push(entry);
  pumpHighQueue();

  return () => {
    if (entry.cancelled) return;
    entry.cancelled = true;

    const queuedIndex = highQueue.indexOf(entry);
    if (queuedIndex >= 0) {
      highQueue.splice(queuedIndex, 1);
      return;
    }

    if (entry.started && entry.img) {
      entry.img.onload = null;
      entry.img.onerror = null;
      entry.img.src = '';
      activeHighLoads = Math.max(0, activeHighLoads - 1);
      pumpHighQueue();
    }
  };
}

export function PhotoCard({ photo, isSelected, getSelectionCount, cardWidth, thumbHeight, cardHeight, thumbTargetSize, thumbLowTargetSize, imgLoading = 'lazy', imgFetchPriority = 'auto', onClick, onDoubleClick, onOpenDetails, onDragStart, onDragEnd, onFirstThumbLoad }: PhotoCardProps) {
  const lowSize = thumbLowTargetSize ?? 400;
  const highSize = thumbTargetSize ?? lowSize;
  const lowUrl = useMemo(() => api.thumbUrl(photo.path, lowSize), [photo.path, lowSize]);
  const highUrl = useMemo(() => api.thumbUrl(photo.path, highSize), [photo.path, highSize]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isHighQuality, setIsHighQuality] = useState(false);
  const [displaySrc, setDisplaySrc] = useState(() => lowUrl);
  const [thumbSize, setThumbSize] = useState({ w: 0, h: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragSelectionCount, setDragSelectionCount] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const loadedSrcRef = useRef<string | null>(null);
  const dragStartRef = useRef<{ x: number, y: number } | null>(null);
  const isDraggingInternal = useRef(false);
  const promoteCancelRef = useRef<(() => void) | null>(null);
  const promoteTimerRef = useRef<number | null>(null);

  const isMapped = isPhotoMapped(photo);
  const isDiscarded = photo.discarded === true;
  const knownNames = (photo.faces ?? [])
    .filter(isKnownFace)
    .map((f) => f.aluno_id)
    .filter((v, idx, a) => a.indexOf(v) === idx);
  const firstName = knownNames.length > 0 ? knownNames.join(', ') : 'Não mapeada';

  useEffect(() => {
    const shouldPromoteHigh = highUrl !== lowUrl && highSize > lowSize;

    if (promoteTimerRef.current != null) {
      window.clearTimeout(promoteTimerRef.current);
      promoteTimerRef.current = null;
    }
    promoteCancelRef.current?.();
    promoteCancelRef.current = null;

    setHasError(false);
    setIsHighQuality(false);
    setDisplaySrc(lowUrl);
    setIsLoaded(false);
    loadedSrcRef.current = null;

    if (!shouldPromoteHigh) {
      return () => {
        if (promoteTimerRef.current != null) {
          window.clearTimeout(promoteTimerRef.current);
          promoteTimerRef.current = null;
        }
        promoteCancelRef.current?.();
        promoteCancelRef.current = null;
      };
    }

    return () => {
      if (promoteTimerRef.current != null) {
        window.clearTimeout(promoteTimerRef.current);
        promoteTimerRef.current = null;
      }
      promoteCancelRef.current?.();
      promoteCancelRef.current = null;
    };
  }, [lowUrl, highUrl, highSize, lowSize]);

  useEffect(() => {
    if (!isLoaded) return;

    const shouldPromoteHigh = highUrl !== lowUrl && highSize > lowSize;
    if (!shouldPromoteHigh) return;

    promoteTimerRef.current = window.setTimeout(() => {
      promoteCancelRef.current = enqueueHighQualityLoad(
        highUrl,
        () => {
          setDisplaySrc(highUrl);
          setIsHighQuality(true);
        },
        () => {
          setIsHighQuality(false);
        }
      );
      promoteTimerRef.current = null;
    }, 180);

    return () => {
      if (promoteTimerRef.current != null) {
        window.clearTimeout(promoteTimerRef.current);
        promoteTimerRef.current = null;
      }
      promoteCancelRef.current?.();
      promoteCancelRef.current = null;
    };
  }, [isLoaded, highUrl, lowUrl, highSize, lowSize]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setThumbSize({ w: rect.width, h: rect.height });
      }
    };

    measure();

    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return; // Only left click
    
    // Ignore if clicking on interactive elements like the details button
    if ((e.target as HTMLElement).closest('[data-interactive="true"]')) {
      return;
    }

    dragStartRef.current = { x: e.clientX, y: e.clientY };
    isDraggingInternal.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragStartRef.current) return;
    
    if (!isDraggingInternal.current) {
      const dx = Math.abs(e.clientX - dragStartRef.current.x);
      const dy = Math.abs(e.clientY - dragStartRef.current.y);
      if (dx + dy > 8) {
        isDraggingInternal.current = true;
        setIsDragging(true);
        setDragSelectionCount(getSelectionCount?.() ?? 1);
        onDragStart?.(photo, e);
      }
    }
  };

  const wasDraggingRef = useRef(false);

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isDraggingInternal.current) {
      onDragEnd?.(photo, e);
      wasDraggingRef.current = true;
      // Pequeno delay para evitar que o clique dispare imediatamente após o drag
      setTimeout(() => {
        wasDraggingRef.current = false;
      }, 100);
    }
    dragStartRef.current = null;
    isDraggingInternal.current = false;
    setIsDragging(false);
    setDragSelectionCount(0);
  };

  const handleImageLoad = useCallback(() => {
    if (displaySrc) {
      loadedSrcRef.current = displaySrc;
    }
    setIsLoaded(true);
    onFirstThumbLoad?.();
  }, [displaySrc, onFirstThumbLoad]);

  const cardStyle: React.CSSProperties = {
    width: cardWidth ? `${cardWidth}px` : '100%',
    minWidth: cardWidth ? `${cardWidth}px` : undefined,
    height: cardHeight ? `${cardHeight}px` : '100%',
    userSelect: 'none' as const,
    touchAction: 'none' as const,
    contentVisibility: 'auto' as const,
    containIntrinsicSize: cardWidth && cardHeight ? `${cardWidth}px ${cardHeight}px` : '320px 360px',
    transition: 'border-color .16s ease, box-shadow .16s ease, transform .16s ease, background .16s ease',
    transform: isHovered ? 'translateY(-2px)' : 'translateY(0)',
    borderColor: isSelected ? 'rgba(96, 165, 250, 0.85)' : isHovered ? 'rgba(148, 163, 184, 0.18)' : undefined,
    boxShadow: isSelected
      ? '0 0 0 1px rgba(59, 130, 246, 0.26) inset, 0 12px 28px rgba(37, 99, 235, 0.14), 0 0 0 1px rgba(96, 165, 250, 0.08)'
      : isHovered
      ? '0 12px 24px rgba(0, 0, 0, 0.18)'
      : undefined,
    background: isSelected && isDiscarded
      ? 'linear-gradient(180deg, rgba(127, 29, 29, 0.54), rgba(15, 23, 42, 0.92))'
      : isSelected
      ? 'linear-gradient(180deg, rgba(37, 99, 235, 0.12), rgba(15, 23, 42, 0.92))'
      : undefined,
  };

  return (
    <div
      className={`photo-card ${isSelected ? 'selected' : ''} ${isDiscarded ? 'discarded' : ''}`}
      onClick={(e) => {
        if (wasDraggingRef.current) return;
        onClick(photo, e);
      }}
      onDoubleClick={() => !wasDraggingRef.current && onDoubleClick?.(photo)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={cardStyle}
    >
      <div
        className="photo-img-placeholder"
        ref={containerRef}
        style={thumbHeight ? { height: `${thumbHeight}px`, flex: '0 0 auto' } : undefined}
      >
        {!hasError && (
          <>
            <img
              ref={imgRef}
              src={displaySrc || api.thumbUrl(photo.path, thumbLowTargetSize ?? 400)}
              alt={photo.name}
              loading={imgLoading}
              fetchPriority={imgFetchPriority}
              decoding="async"
              draggable={false}
              style={{
                opacity: isLoaded ? 1 : 0,
                userSelect: 'none',
                pointerEvents: 'none',
                filter: isHighQuality ? 'none' : 'blur(0.5px)',
              }}
              onLoad={handleImageLoad}
              onError={() => {
                if (!loadedSrcRef.current) {
                  setHasError(true);
                } else {
                  setDisplaySrc(loadedSrcRef.current);
                  setIsHighQuality(false);
                }
              }}
            />
            <button
              data-interactive="true"
              onClick={(e) => {
                e.stopPropagation();
                onOpenDetails(photo);
              }}
              title="Ver detalhes"
              className="photo-card-details-btn"
              style={{
                position: 'absolute',
                bottom: '6px',
                right: '6px',
                zIndex: 10,
                background: 'rgba(0,0,0,0.6)',
                border: 'none',
                borderRadius: '4px',
                padding: '4px',
                color: 'white',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: 0.8,
                transition: 'opacity 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
              onMouseLeave={(e) => e.currentTarget.style.opacity = '0.8'}
            >
              <MoreHorizontal size={16} />
            </button>
            {isLoaded && thumbSize.w > 0 && photo.width && photo.height && (photo.faces || []).map((face, idx) => (
                <React.Fragment key={face.rowid ?? idx}>
                  {renderFaceOverlay(face, thumbSize, photo.width!, photo.height!)}
                </React.Fragment>
              ))}
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: 'inherit',
                pointerEvents: 'none',
                background: isSelected
                  ? 'linear-gradient(180deg, rgba(59, 130, 246, 0.10), rgba(59, 130, 246, 0.02) 42%, transparent 68%)'
                  : isHovered
                  ? 'linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 64%)'
                  : 'transparent',
                boxShadow: isSelected ? 'inset 0 0 0 1px rgba(96, 165, 250, 0.18)' : 'none',
                zIndex: 2,
              }}
            />
          </>
        )}
        {!isLoaded && !hasError && <div className="photo-skeleton" />}
        {hasError && (
          <div className="photo-error-fallback">
            <ImageIcon size={24} opacity={0.4} />
            <span>Erro</span>
          </div>
        )}
        {isPhotoBlurry(photo) && (
          <div className="blur-badge blur-blurry">Desfocada</div>
        )}
        {isPhotoAttention(photo) && (
          <div className="blur-badge blur-attention">Verificar foco</div>
        )}
        {isDiscarded && (
          <div className="discardBadge">DESCARTADA</div>
        )}
        {isDragging && dragSelectionCount > 1 && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: '8px',
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 25,
              background: 'rgba(15, 23, 42, 0.92)',
              border: '1px solid rgba(96, 165, 250, 0.26)',
              color: '#dbeafe',
              borderRadius: '999px',
              padding: '4px 10px',
              fontSize: '0.7rem',
              fontWeight: 700,
              letterSpacing: '0.01em',
              boxShadow: '0 8px 20px rgba(15, 23, 42, 0.35)',
              pointerEvents: 'none',
            }}
          >
            {dragSelectionCount} fotos
          </div>
        )}
        <div
          className={`photo-card-check ${isSelected ? 'photo-card-check-visible' : 'photo-card-check-hidden'}`}
          aria-hidden={!isSelected}
          style={{
            position: 'absolute',
            right: '8px',
            top: '8px',
            background: 'rgba(10, 17, 29, 0.88)',
            color: 'white',
            border: '1px solid rgba(96, 165, 250, 0.30)',
            borderRadius: '999px',
            width: 'auto',
            height: '28px',
            padding: '0 10px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            justifyContent: 'center',
            opacity: isSelected ? 1 : 0,
            transition: 'opacity 0.2s',
            pointerEvents: 'none',
            zIndex: 20,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span style={{ fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.01em', whiteSpace: 'nowrap' }}>Selecionada</span>
        </div>
      </div>
      <div className="photo-info">
        <div className="photo-name" title={photo.name}>
          {photo.name}
        </div>
        <div className="photo-status">
          <div className={`status-indicator ${isMapped ? 'mapped' : 'unmapped'}`} />
          <span>{firstName}</span>
        </div>
      </div>
    </div>
  );
}

export const MemoPhotoCard = memo(PhotoCard);
