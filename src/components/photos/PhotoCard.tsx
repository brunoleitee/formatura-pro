import React, { memo, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Image as ImageIcon, Brain, ScanFace, FileText } from 'lucide-react';
import { type Photo } from '../../services/api';
import { isPhotoBlurry, isPhotoAttention } from '../../utils/qualityUtils';
import { isPhotoMapped, isKnownFace } from '../../utils/personIdentity';
import { getGridThumbUrl } from '../../utils/imageUrls';
import { isPerfLoggingEnabled, logPerf, perfNow } from '../../utils/perf';
import { aiCacheStore } from '../../services/AICacheStore';
import { ratingCache } from '../../services/RatingCache';
import { thumbManager } from '../../services/ThumbRequestManager';
import styles from './PhotoCard.module.css';

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

const FaceOverlayBox = memo(function FaceOverlayBox({
  face, containerSize, photoWidth, photoHeight
}: {
  face: Photo['faces'][number];
  containerSize: { w: number, h: number };
  photoWidth: number;
  photoHeight: number;
}) {
  if (face.x1 == null || !photoWidth || !photoHeight) return null;

  const imgRatio = photoWidth / photoHeight;
  const containerRatio = containerSize.w / containerSize.h;

  let renderedW = containerSize.w;
  let renderedH = containerSize.h;

  if (imgRatio > containerRatio) {
    renderedH = containerSize.w / imgRatio;
  } else {
    renderedW = containerSize.h * imgRatio;
  }

  const offsetX = (containerSize.w - renderedW) / 2;
  const offsetY = (containerSize.h - renderedH) / 2;
  const isKnown = isKnownFace(face);

  const x1 = offsetX + (face.x1 / photoWidth) * renderedW;
  const y1 = offsetY + (face.y1 / photoHeight) * renderedH;
  const widthPx = ((face.x2 - face.x1) / photoWidth) * renderedW;
  const heightPx = ((face.y2 - face.y1) / photoHeight) * renderedH;
  const color = isKnown ? 'rgba(34, 197, 94, 0.8)' : 'rgba(255, 255, 255, 0.4)';

  return (
    <div
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
        <div className={`${styles.faceLabel} ${styles.faceLabelFg}`}>
          1º plano
        </div>
      )}
      {(face.is_foreground === 0 || (face.foreground_score !== undefined && face.foreground_score !== null && face.foreground_score < 0.45)) && (
        <div className={`${styles.faceLabel} ${styles.faceLabelBg}`}>
          2º plano {face.background_penalty_reason ? `(${face.background_penalty_reason})` : ''}
        </div>
      )}
    </div>
  );
});

const CardInfoSection = memo(function CardInfoSection({
  photo, isMapped, firstName, showRating, photoMeta
}: {
  photo: Photo;
  isMapped: boolean;
  firstName: string;
  showRating: boolean;
  photoMeta: { rating: number; favorite: boolean };
}) {
  return (
    <div className="photo-info">
      <div className={`photo-name ${styles.photoNameRow}`} title={photo.name}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto', minWidth: 0 }}>{photo.name}</span>
        {showRating && (
          <span data-scroll-hide className={styles.ratingBadge} title={`Rating: ${photoMeta.rating}`}>
            {'★'.repeat(photoMeta.rating)}{'☆'.repeat(5 - photoMeta.rating)}
          </span>
        )}
      </div>
      <div className="photo-status">
        <div className={`status-indicator ${isMapped ? 'mapped' : 'unmapped'}`} />
        <span>{firstName}</span>
      </div>
    </div>
  );
});

export function PhotoCard({ photo, isSelected, getSelectionCount, cardWidth, thumbHeight, cardHeight, thumbTargetSize, thumbLowTargetSize, imgLoading = 'lazy', imgFetchPriority = 'auto', onClick, onDoubleClick, onOpenDetails, onDragStart, onDragEnd, onFirstThumbLoad }: PhotoCardProps) {
  const thumbSize = (thumbTargetSize ?? 240) > 0 ? (thumbTargetSize ?? 240) : 0;
  const thumbUrl = useMemo(
    () => thumbSize > 0 ? (getGridThumbUrl(photo.path, thumbSize, 70) ?? '') : '',
    [photo.path, thumbSize]
  );
  const thumbKey = useMemo(() => `thumb:${photo.path}:${thumbSize}`, [photo.path, thumbSize]);

  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragSelectionCount, setDragSelectionCount] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: cardWidth ?? 320, h: thumbHeight ?? 240 });

  useEffect(() => {
    if (cardWidth && thumbHeight) {
      setContainerSize({ w: cardWidth, h: thumbHeight });
      return;
    }

    const el = containerRef.current;
    if (!el) return;

    setContainerSize({
      w: el.getBoundingClientRect().width || cardWidth || 320,
      h: el.getBoundingClientRect().height || thumbHeight || 240
    });

    const observer = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0) return;
      const entry = entries[0];
      const rect = entry.target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setContainerSize({ w: rect.width, h: rect.height });
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [cardWidth, thumbHeight]);

  const imgStyle = useMemo(() => ({
    objectFit: 'contain' as const,
    objectPosition: 'center center' as const,
  }), []);
  const dragStartRef = useRef<{ x: number, y: number } | null>(null);
  const isDraggingInternal = useRef(false);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!thumbUrl) return;
    let cancelled = false;
    let blob: string | null = null;

    thumbManager.request(thumbUrl, thumbKey, 2).then((url) => {
      if (cancelled) {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        return;
      }
      blob = url;
      if (blobUrlRef.current && blobUrlRef.current.startsWith('blob:')) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
      blobUrlRef.current = url;
      if (imgRef.current) {
        imgRef.current.src = url;
      }
    }).catch(() => {});

    return () => {
      cancelled = true;
      thumbManager.cancel(thumbKey);
      if (blob && blob.startsWith('blob:')) URL.revokeObjectURL(blob);
    };
  }, [thumbUrl, thumbKey]);

  useEffect(() => () => {
    if (blobUrlRef.current && blobUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(blobUrlRef.current);
    }
  }, []);

  const imageContext = useMemo(() => `photo=${photo.path} size=${thumbSize}`, [photo.path, thumbSize]);

  const isMapped = isPhotoMapped(photo);
  const isDiscarded = photo.discarded === true;
  const knownNames = (photo.faces ?? [])
    .filter(isKnownFace)
    .map((f) => f.aluno_id)
    .filter((v, idx, a) => a.indexOf(v) === idx);
  const firstName = knownNames.length > 0 ? knownNames.join(', ') : 'Não mapeada';

  const [aiTick, setAiTick] = useState(0);
  useEffect(() => aiCacheStore.subscribeToPath(photo.path, () => setAiTick((t) => t + 1)), [photo.path]);
  const [ratingTick, setRatingTick] = useState(0);
  useEffect(() => ratingCache.subscribeToPath(photo.path, () => setRatingTick((t) => t + 1)), [photo.path]);
  const aiResult = aiCacheStore.get(photo.path);
  const aiOcrFinal = aiResult?.final_student || aiResult?.suggested_id || aiResult?.ocr_text;
  const showAiBadge = aiTick >= 0 && aiResult?.status === "completed" && (aiResult.face_detected || !!aiOcrFinal);
  const isAiProcessing = aiResult?.status === "processing" || aiResult?.status === "pending";
  const photoMeta = ratingCache.get(photo.path);
  const showRating = photoMeta.rating > 0;
  const showFavorite = photoMeta.favorite;

  useEffect(() => {
    setHasError(false);
    setIsLoaded(false);
  }, [thumbUrl]);

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
    setIsLoaded(true);
    if (isPerfLoggingEnabled()) {
      logPerf('catalog image load', perfNow(), imageContext);
    }
    onFirstThumbLoad?.();
  }, [onFirstThumbLoad, imageContext]);

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
      className={`photo-card ${isSelected ? 'selected' : ''} ${isDiscarded ? 'discarded' : ''} ${photo.folder_active === false ? 'photo-inactive' : ''}`}
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
        style={thumbHeight ? {
          height: `${thumbHeight}px`,
          flexShrink: 0,
          overflow: 'hidden',
          background: isLoaded ? 'transparent' : '#111',
        } : undefined}
      >
        {!hasError && (
          <>
            <img
              ref={imgRef}
              alt={photo.name}
              loading={imgLoading}
              fetchPriority={imgFetchPriority}
              draggable={false}
              style={{
                opacity: isLoaded ? 1 : 0,
                userSelect: 'none',
                pointerEvents: 'none',
                position: 'relative',
                width: '100%',
                height: '100%',
                display: 'block',
                ...imgStyle,
              }}
              onLoad={handleImageLoad}
              onError={() => setHasError(true)}
            />
            {isLoaded && containerSize.w > 0 && photo.width && photo.height && (photo.faces || []).map((face, idx) => (
                  idx < 10 && (
                  <div key={face.rowid ?? idx} data-scroll-hide>
                    <FaceOverlayBox
                      face={face}
                      containerSize={containerSize}
                      photoWidth={photo.width!}
                      photoHeight={photo.height!}
                    />
                  </div>
                )
              ))}
            <div
              data-scroll-hide
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
          <div data-scroll-hide className={`${styles.blurBadge} ${styles.blurBadgeBlurry}`} title="Desfocada">Desfocada</div>
        )}
        {isPhotoAttention(photo) && (
          <div data-scroll-hide className={`${styles.blurBadge} ${styles.blurBadgeAttention}`} title="Atenção">Verificar foco</div>
        )}
        {isDiscarded && (
          <div data-scroll-hide className={styles.discardBadge}>Descartada</div>
        )}
        {isAiProcessing && (
          <div data-scroll-hide className={`${styles.aiBadge} ${styles.aiProcessing}`}>IA...</div>
        )}
        {showAiBadge && (
          <div data-scroll-hide className={`${styles.aiBadge} ${styles.aiReady}`} title={aiOcrFinal ? `OCR: ${aiOcrFinal}` : aiResult?.face_detected ? 'Rosto detectado' : ''}>
            {aiResult?.face_detected ? <ScanFace size={10} /> : null}
            {aiOcrFinal ? <FileText size={10} /> : null}
            {aiResult?.face_detected && aiOcrFinal ? null : !aiResult?.face_detected && !aiOcrFinal ? <Brain size={10} /> : null}
          </div>
        )}
        {showFavorite && (
          <div data-scroll-hide className={styles.favBadge} title="Favorito">❤</div>
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
          data-scroll-hide
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
      <CardInfoSection
        photo={photo}
        isMapped={isMapped}
        firstName={firstName}
        showRating={showRating}
        photoMeta={photoMeta}
      />
    </div>
  );
}

export const MemoPhotoCard = memo(PhotoCard);
