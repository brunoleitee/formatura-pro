import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, Search, UserCheck, UserMinus, Plus, ArrowUp, ArrowDown, FolderOpen, Brain } from 'lucide-react';
import { api, type Photo } from '../../services/api';
import { isKnownFace } from '../../utils/personIdentity';
import { useApp } from '../../context/AppContext';
import { logPerf, perfNow } from '../../utils/perf';
import { getGridHighThumbUrl, getGridThumbUrl, getViewerPreviewUrl, buildPhotoSourceUrl } from '../../utils/imageUrls';
import { aiQueueManager } from '../../services/AIQueueManager';
import { aiCacheStore } from '../../services/AICacheStore';
import { aiApi } from '../../services/aiApi';
import styles from './PhotoViewerModal.module.css';

interface PhotoViewerModalProps {
  photo: Photo;
  allPhotos: Photo[];
  contextPhotos?: Photo[];
  contextBadge?: string | null;
  contextLoading?: boolean;
  onClose: () => void;
  onNavigate: (photo: Photo) => void;
  onPhotoUpdate?: (photo: Photo) => void;
  onDiscard?: (path: string) => void;
  onRestore?: (path: string) => void;
}

interface SimilarResult {
  rowid: number;
  photo_path: string;
  thumb_url: string;
  score: number;
  aluno_id: string | null;
  box?: number[];
  image_width?: number;
  image_height?: number;
}

type ViewerPhoto = Photo & {
  id?: string | number | null;
  preview_path?: string | null;
  thumb_path?: string | null;
  original_path?: string | null;
};

function getViewerImageUrl(photo: Photo, maxSize = 1920) {
  const extended = photo as ViewerPhoto;
  const sourcePath = extended.preview_path || extended.original_path || photo.path;
  if (extended.preview_path) return extended.preview_path;
  const photoSrcUrl = buildPhotoSourceUrl(sourcePath);
  console.log("[Viewer] usando PhotoSource:", photoSrcUrl);
  return photoSrcUrl;
}

function getViewerFallbackUrl(photo: Photo) {
  const extended = photo as ViewerPhoto;
  const sourcePath = extended.thumb_path || extended.original_path || photo.path;
  return extended.thumb_path || getGridHighThumbUrl(sourcePath, 1200) || '';
}

export function PhotoViewerModal({
  photo,
  allPhotos,
  contextPhotos,
  contextBadge,
  contextLoading = false,
  onClose,
  onNavigate,
  onPhotoUpdate,
  onDiscard,
  onRestore,
}: PhotoViewerModalProps) {
  const { currentCatalog } = useApp();
  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  const [isLoaded, setIsLoaded] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [activeMenu, setActiveMenu] = useState<number | null>(null);
  const [isManualMode, setIsManualMode] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawCurrent, setDrawCurrent] = useState<{ x: number; y: number } | null>(null);
  const [showRenameModal, setShowRenameModal] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [similarResults, setSimilarResults] = useState<SimilarResult[]>([]);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarError, setSimilarError] = useState<string | null>(null);
  const [similarName, setSimilarName] = useState('');
  const [selectedSimilarIds, setSelectedSimilarIds] = useState<Set<number>>(new Set());
  const [applyingSimilarName, setApplyingSimilarName] = useState(false);
  const [similarViewMode, setSimilarViewMode] = useState<'face' | 'photo'>('face');
  const [showManualModal, setShowManualModal] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [manualAlunoId, setManualAlunoId] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartPos, setDragStartPos] = useState({ x: 0, y: 0 });
  const [isWheelZooming, setIsWheelZooming] = useState(false);
  const VIEWER_PREVIEW_SIZE = 1920;
  const [displayedSrc, setDisplayedSrc] = useState(() => getViewerFallbackUrl(photo));
  const [displayedPhoto, setDisplayedPhoto] = useState<Photo>(photo);
  const navigationPhotos = (contextPhotos?.length ? contextPhotos : allPhotos);
  const viewerTransitionRef = useRef<'open' | 'next' | 'prev'>('open');
  const viewerLoadStartRef = useRef<number | null>(null);
  const viewerMountedRef = useRef(false);
  const viewerLoggedRef = useRef(false);
  const requestIdRef = useRef(0);
  const previewTokenRef = useRef(0);
  const previewStartRef = useRef<number | null>(null);
  const imageCacheRef = useRef(new Map<string, { status: 'loading' | 'loaded' | 'error'; promise?: Promise<boolean> }>());
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const wheelCommitRef = useRef<number | null>(null);
  const wheelResetTimerRef = useRef<number | null>(null);
  const filmstripRef = useRef<HTMLDivElement | null>(null);
  const thumbRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const filmstripScrollTimerRef = useRef<number | null>(null);
  const filmstripUserScrollRef = useRef(false);
  const [aiCacheTick, setAiCacheTick] = useState(0);

  useEffect(() => {
    viewerLoadStartRef.current = perfNow();
    viewerLoggedRef.current = false;
    if (viewerMountedRef.current) {
      logPerf(`viewer switch ${viewerTransitionRef.current}`, viewerLoadStartRef.current, photo.path);
    } else {
      viewerMountedRef.current = true;
    }
  }, [photo.path]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => {
    return () => {
      if (wheelCommitRef.current !== null) {
        window.cancelAnimationFrame(wheelCommitRef.current);
        wheelCommitRef.current = null;
      }
      if (wheelResetTimerRef.current !== null) {
        window.clearTimeout(wheelResetTimerRef.current);
        wheelResetTimerRef.current = null;
      }
    };
  }, []);

  const imageRef = useRef<HTMLImageElement>(null);
  const imageWrapRef = useRef<HTMLDivElement>(null);
  const imageStageRef = useRef<HTMLDivElement>(null);
  const visiblePhoto = displayedPhoto;
  const currentIndex = navigationPhotos.findIndex((p) => p.path === photo.path);
  const total = navigationPhotos.length;
  const displayIndex = navigationPhotos.findIndex((p) => p.path === visiblePhoto.path);
  const displayCounter = displayIndex >= 0 ? displayIndex + 1 : 1;
  const isDiscarded = visiblePhoto.discarded;
  const currentPhotoKey = (visiblePhoto as ViewerPhoto).original_path ?? visiblePhoto.path;

  const getViewerPhotoKey = useCallback((item: Photo) => (
    (item as ViewerPhoto).id ?? (item as ViewerPhoto).original_path ?? item.path
  ), []);

  const clamp = (val: number, min: number, max: number) => Math.min(Math.max(val, min), max);
  const clamp01 = (val: number) => clamp(val, 0, 1);

  const getImagePoint = useCallback((clientX: number, clientY: number) => {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;

    const x = clientX - rect.left;
    const y = clientY - rect.top;

    return {
      x: x / rect.width,
      y: y / rect.height,
      rect,
    };
  }, []);

  const calculateInitialPan = (w: number, h: number) => {
    if (!imageStageRef.current) return { x: 0, y: 0 };
    const stageW = imageStageRef.current.clientWidth;
    const stageH = imageStageRef.current.clientHeight;
    return {
      x: (stageW - w) / 2,
      y: (stageH - h) / 2
    };
  };

  const showFeedbackMsg = useCallback((text: string) => {
    setFeedback(text);
    setTimeout(() => setFeedback(null), 2000);
  }, []);

  const loadPreview = useCallback((url: string) => {
    const existing = imageCacheRef.current.get(url);
    if (existing?.status === 'loaded') {
      return Promise.resolve(true);
    }
    if (existing?.promise) {
      return existing.promise;
    }

    const promise = new Promise<boolean>((resolve) => {
      const img = new window.Image();
      img.decoding = 'async';
      img.onload = () => {
        imageCacheRef.current.set(url, { status: 'loaded' });
        resolve(true);
      };
      img.onerror = () => {
        imageCacheRef.current.set(url, { status: 'error' });
        resolve(false);
      };
      img.src = url;
    });

    imageCacheRef.current.set(url, { status: 'loading', promise });
    return promise;
  }, []);

  const handleDiscard = async () => {
    try {
      await api.discardPhoto({ foto_path: visiblePhoto.path, discard: true });
      showFeedbackMsg("Foto descartada");
      onDiscard?.(visiblePhoto.path);
      if (currentIndex < total - 1) onNavigate(navigationPhotos[currentIndex + 1]);
    } catch (err) {
      console.error("Erro ao descartar:", err);
    }
  };

  const handleRestore = async () => {
    try {
      await api.discardPhoto({ foto_path: visiblePhoto.path, discard: false });
      showFeedbackMsg("Foto restaurada");
      onRestore?.(visiblePhoto.path);
    } catch (err) {
      console.error("Erro ao restaurar:", err);
    }
  };

  const handleRename = async (faceIdx: number) => {
    const face = visiblePhoto.faces?.[faceIdx];
    if (!face) return;
    try {
      await api.bulkManualIdentify(currentCatalog, renameValue, face.rowid ? [face.rowid] : []);
      showFeedbackMsg(`Vinculado: ${renameValue}`);
      setShowRenameModal(null);
      setRenameValue('');
      onPhotoUpdate?.({ ...visiblePhoto });
    } catch (err) {
      console.error("Erro ao renomear:", err);
      showFeedbackMsg("Erro ao vincular");
    }
  };

  const handleRemoveIdent = async (faceIdx: number) => {
    const face = visiblePhoto.faces?.[faceIdx];
    if (!face) return;
    try {
      await api.bulkManualIdentify(currentCatalog, 'Desconhecido', face.rowid ? [face.rowid] : []);
      showFeedbackMsg("IdentificaÃ§Ã£o removida");
      setActiveMenu(null);
      onPhotoUpdate?.({ ...visiblePhoto });
    } catch (err) {
      console.error("Erro ao remover:", err);
    }
  };

  const handleSearchSimilar = async (faceIdx: number) => {
    const face = visiblePhoto.faces?.[faceIdx];
    if (!face) return;
    setSimilarLoading(true);
    setSimilarError(null);
    setActiveMenu(null);
    setSimilarName('');
    setSelectedSimilarIds(new Set());
    try {
      const results = await api.searchSimilarFaces(face.rowid ?? 0, currentCatalog, 50);
      setSimilarResults(results.results ?? []);
      if ((results.results ?? []).length === 0) setSimilarError('Nenhuma face semelhante encontrada');
    } catch (err: any) {
      const msg = err?.detail || err?.message || 'Erro ao buscar semelhantes';
      setSimilarError(msg);
      setSimilarResults([]);
    } finally {
      setSimilarLoading(false);
    }
  };

  const toggleSimilarSelection = (rowid: number) => {
    setSelectedSimilarIds(prev => {
      const next = new Set(prev);
      if (next.has(rowid)) next.delete(rowid);
      else next.add(rowid);
      return next;
    });
  };

  const handleApplySimilarName = async () => {
    if (!similarName.trim() || similarResults.length === 0) return;
    
    const rowids = selectedSimilarIds.size > 0 
      ? Array.from(selectedSimilarIds)
      : similarResults.map(r => r.rowid);

    setApplyingSimilarName(true);
    try {
      await api.bulkManualIdentify(currentCatalog, similarName.trim(), rowids);
      showFeedbackMsg(`VÃ­nculo aplicado a ${rowids.length} faces`);
      
      setSimilarResults(prev => prev.map(r => 
        rowids.includes(r.rowid) ? { ...r, aluno_id: similarName.trim() } : r
      ));
      
      setSelectedSimilarIds(new Set());
      setSimilarName('');
      onPhotoUpdate?.({ ...visiblePhoto });
    } catch (err) {
      console.error("Erro ao aplicar nome em lote:", err);
      showFeedbackMsg("Erro ao aplicar nome");
    } finally {
      setApplyingSimilarName(false);
    }
  };

  const handleAddManualFace = async () => {
    if (!manualAlunoId.trim() || !showManualModal) return;
    if (!visiblePhoto.width || !visiblePhoto.height) {
      showFeedbackMsg("Imagem indisponível para salvar o rosto manual");
      return;
    }

    const x1 = Math.round(showManualModal.x * visiblePhoto.width);
    const y1 = Math.round(showManualModal.y * visiblePhoto.height);
    const x2 = Math.round((showManualModal.x + showManualModal.width) * visiblePhoto.width);
    const y2 = Math.round((showManualModal.y + showManualModal.height) * visiblePhoto.height);

    try {
      await api.addManualFace({
        foto_path: visiblePhoto.path,
        catalog: currentCatalog,
        box: [x1, y1, x2, y2],
        new_name: manualAlunoId.trim(),
      });
      showFeedbackMsg("Rosto manual adicionado");
      setShowManualModal(null);
      setManualAlunoId('');
      setIsManualMode(false);
      onPhotoUpdate?.({ ...visiblePhoto });
    } catch (err) {
      console.error("Erro ao adicionar rosto manual:", err);
      showFeedbackMsg("Erro ao adicionar rosto");
    }
  };

  useEffect(() => {
    setZoom(1);
    setPan(calculateInitialPan(viewSize.w, viewSize.h));
    zoomRef.current = 1;
    panRef.current = calculateInitialPan(viewSize.w, viewSize.h);
    setIsWheelZooming(false);
    if (wheelCommitRef.current !== null) {
      window.cancelAnimationFrame(wheelCommitRef.current);
      wheelCommitRef.current = null;
    }
    if (wheelResetTimerRef.current !== null) {
      window.clearTimeout(wheelResetTimerRef.current);
      wheelResetTimerRef.current = null;
    }
    // Initial pan will be set in onLoad when image size is known
  }, [photo.path]);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const token = ++previewTokenRef.current;
    previewStartRef.current = perfNow();
    viewerLoggedRef.current = false;
    const currentUrl = getViewerImageUrl(photo, VIEWER_PREVIEW_SIZE);
    const fallbackUrl = getViewerFallbackUrl(photo);
    const PREVIEW_TIMEOUT_MS = 4500;

    const preloadImage = (targetPhoto: Photo) => {
      const targetUrl = getViewerImageUrl(targetPhoto, VIEWER_PREVIEW_SIZE);
      if (!targetUrl) return;

      const cached = imageCacheRef.current.get(targetUrl);
      if (cached?.status === 'loaded') {
        return;
      }

      void loadPreview(targetUrl);
    };

    const settleCurrent = (url: string, sourcePhoto: Photo, kind: 'cache-miss' | 'fallback') => {
      if (requestId !== requestIdRef.current) return false;
      setDisplayedPhoto(sourcePhoto);
      setDisplayedSrc(url);
      setIsLoaded(true);
      if (previewStartRef.current !== null) {
        logPerf(`viewer preview ${kind}`, previewStartRef.current, sourcePhoto.path);
      }
      return true;
    };

    if (imageCacheRef.current.get(currentUrl)?.status === 'loaded') {
      setDisplayedPhoto(photo);
      setDisplayedSrc(currentUrl);
      setIsLoaded(true);
      if (previewStartRef.current !== null) {
        logPerf('viewer preview cache hit', previewStartRef.current, photo.path);
      }
    } else {
      const timeoutId = window.setTimeout(() => {
        settleCurrent(fallbackUrl, photo, 'fallback');
      }, PREVIEW_TIMEOUT_MS);

      void loadPreview(currentUrl).then((ok) => {
        window.clearTimeout(timeoutId);
        if (token !== previewTokenRef.current || requestId !== requestIdRef.current) {
          if (previewStartRef.current !== null) {
            logPerf('viewer preview stale ignored', previewStartRef.current, photo.path);
          }
          return;
        }
        if (ok) {
          settleCurrent(currentUrl, photo, 'cache-miss');
          return;
        }
        settleCurrent(fallbackUrl, photo, 'fallback');
      });
    }

    const targets = [
      navigationPhotos[currentIndex],
      navigationPhotos[currentIndex - 2],
      navigationPhotos[currentIndex - 1],
      navigationPhotos[currentIndex + 1],
      navigationPhotos[currentIndex + 2],
    ]
      .filter((item): item is Photo => Boolean(item));
    targets
      .filter((item) => item.path && item.path !== photo.path)
      .forEach((item) => preloadImage(item));
  }, [loadPreview, navigationPhotos, currentIndex, photo.path, (photo as ViewerPhoto).original_path, (photo as ViewerPhoto).preview_path]);

  useEffect(() => {
    const allPaths = navigationPhotos
      .slice(0, 50)
      .map((p) => p.path)
      .filter(Boolean) as string[];
    if (allPaths.length === 0) return;
    let cancelled = false;
    console.log(`[AI-BATCH] consultando status inicial (${allPaths.length} fotos)`);
    aiApi.batchStatus(allPaths).then((res) => {
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
      console.log(`[AI-BATCH] cache encontrado: ${found}`);
      const pending = allPaths.filter((p) => {
        const c = aiCacheStore.get(p);
        return !c || c.status !== "completed";
      });
      console.log(`[AI-BATCH] fotos pendentes: ${pending.length}`);
      aiQueueManager.batchInitialize(pending);
      console.log(`[AI-BATCH] queue inicializada`);
    }).catch(() => {
      if (cancelled) return;
      aiQueueManager.batchInitialize(allPaths);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const currentPath = photo.path || (photo as ViewerPhoto).original_path;
    if (!currentPath) return;
    aiQueueManager.add(currentPath, 3);
    const preloadPaths: string[] = [];
    for (const offset of [-2, -1, 1, 2]) {
      const idx = currentIndex + offset;
      if (idx >= 0 && idx < navigationPhotos.length) {
        const p = navigationPhotos[idx]?.path;
        if (p && p !== currentPath) preloadPaths.push(p);
      }
    }
    for (const p of preloadPaths) {
      aiQueueManager.add(p, 1);
    }
  }, [photo.path, currentIndex]);

  useEffect(() => {
    return aiCacheStore.subscribe(() => setAiCacheTick((t) => t + 1));
  }, []);

  useEffect(() => {
    const container = filmstripRef.current;
    const currentId = currentPhotoKey;
    const el = thumbRefs.current[currentId];
    if (!container || !el) return;

    if (filmstripUserScrollRef.current) return;

    const containerRect = container.getBoundingClientRect();
    const thumbRect = el.getBoundingClientRect();
    const targetLeft =
      container.scrollLeft +
      (thumbRect.left - containerRect.left) -
      (container.clientWidth / 2) +
      (thumbRect.width / 2);

    container.scrollTo({
      left: Math.max(0, targetLeft),
      behavior: 'smooth',
    });
  }, [currentPhotoKey, currentIndex]);

  useEffect(() => {
    return () => {
      if (filmstripScrollTimerRef.current) {
        window.clearTimeout(filmstripScrollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showRenameModal !== null || similarResults.length > 0 || showManualModal) return;
      
      if (e.key === 'p' || e.key === 'P') {
        api.openPhotoshop(visiblePhoto.path);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        handleRestore();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        handleDiscard();
      } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        viewerTransitionRef.current = 'prev';
        if (currentIndex > 0) onNavigate(navigationPhotos[currentIndex - 1]);
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        viewerTransitionRef.current = 'next';
        if (currentIndex < total - 1) onNavigate(navigationPhotos[currentIndex + 1]);
      } else if (e.key === 'Escape') {
        if (isManualMode) {
          setIsManualMode(false);
          setDrawStart(null);
          setDrawCurrent(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photo, currentIndex, total, onNavigate, onClose, isManualMode, showRenameModal, similarResults.length, showManualModal, handleRestore, handleDiscard]);

  const clampPanToStage = useCallback((nextPan: { x: number; y: number }, nextZoom: number) => {
    const stage = imageStageRef.current;
    if (!stage || !viewSize.w || !viewSize.h) return nextPan;

    if (nextZoom <= 1) {
      return calculateInitialPan(viewSize.w, viewSize.h);
    }

    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;
    const contentW = viewSize.w * nextZoom;
    const contentH = viewSize.h * nextZoom;

    let x = nextPan.x;
    let y = nextPan.y;

    if (contentW <= stageW) x = (stageW - contentW) / 2;
    else x = clamp(x, stageW - contentW, 0);

    if (contentH <= stageH) y = (stageH - contentH) / 2;
    else y = clamp(y, stageH - contentH, 0);

    return { x, y };
  }, [viewSize.w, viewSize.h]);

  const handleWheelZoom = useCallback((e: WheelEvent | React.WheelEvent) => {
    if (isManualMode || showRenameModal !== null || similarResults.length > 0 || showManualModal) return;

    e.preventDefault();
    e.stopPropagation();

    const rect = imageStageRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const currentZoom = zoomRef.current;
    const nextZoom = clamp(currentZoom * zoomFactor, 1, 5);

    if (nextZoom === currentZoom) return;

    const scaleChange = nextZoom / currentZoom;
    const currentPan = panRef.current;
    const nextPan = clampPanToStage({
      x: mouseX - (mouseX - currentPan.x) * scaleChange,
      y: mouseY - (mouseY - currentPan.y) * scaleChange,
    }, nextZoom);

    zoomRef.current = nextZoom;
    panRef.current = nextPan;

    setIsWheelZooming(true);
    if (wheelResetTimerRef.current !== null) {
      window.clearTimeout(wheelResetTimerRef.current);
    }
    wheelResetTimerRef.current = window.setTimeout(() => {
      setIsWheelZooming(false);
      wheelResetTimerRef.current = null;
    }, 120);

    if (wheelCommitRef.current !== null) {
      window.cancelAnimationFrame(wheelCommitRef.current);
    }
    wheelCommitRef.current = window.requestAnimationFrame(() => {
      setZoom(zoomRef.current);
      setPan(panRef.current);
      wheelCommitRef.current = null;
    });
  }, [clampPanToStage, isManualMode, showRenameModal, similarResults.length, showManualModal]);

  const handleDoubleClickZoom = (e: React.MouseEvent) => {
    if (isManualMode || showRenameModal !== null || similarResults.length > 0 || showManualModal) return;

    if (zoom > 1) {
      setZoom(1);
      setPan(calculateInitialPan(viewSize.w, viewSize.h));
      zoomRef.current = 1;
      panRef.current = calculateInitialPan(viewSize.w, viewSize.h);
    } else {
      const rect = imageStageRef.current?.getBoundingClientRect();
      if (!rect) return;

      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const nextZoom = 2;
      const currentZoom = zoomRef.current;
      const currentPan = panRef.current;
      const scaleChange = nextZoom / currentZoom;

      const nextPan = clampPanToStage({
        x: mouseX - (mouseX - currentPan.x) * scaleChange,
        y: mouseY - (mouseY - currentPan.y) * scaleChange,
      }, nextZoom);

      zoomRef.current = nextZoom;
      panRef.current = nextPan;
      setZoom(nextZoom);
      setPan(nextPan);
    }
  };

  const handleZoomMouseDown = (e: React.MouseEvent) => {
    if (zoom > 1 && !isManualMode) {
      setIsDragging(true);
      setDragStartPos({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      e.preventDefault();
    } else {
      handleMouseDown(e);
    }
  };

  useEffect(() => {
    if (!isDragging) return;

    const onMove = (e: MouseEvent) => {
      setPan({
        x: e.clientX - dragStartPos.x,
        y: e.clientY - dragStartPos.y
      });
    };

    const onUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDragging, dragStartPos]);

  useEffect(() => {
    const stage = imageStageRef.current;
    if (!stage) return;

    const onWheel = (event: WheelEvent) => handleWheelZoom(event);
    stage.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      stage.removeEventListener('wheel', onWheel);
    };
  }, [handleWheelZoom, photo.path]);

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    viewerTransitionRef.current = 'prev';
    if (currentIndex > 0) onNavigate(navigationPhotos[currentIndex - 1]);
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    viewerTransitionRef.current = 'next';
    if (currentIndex < total - 1) onNavigate(navigationPhotos[currentIndex + 1]);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isManualMode) return;
    const point = getImagePoint(e.clientX, e.clientY);
    if (!point || point.x < 0 || point.y < 0 || point.x > 1 || point.y > 1) return;
    setDrawStart({ x: point.x, y: point.y });
    setDrawCurrent(null);
  };

  useEffect(() => {
    if (!drawStart || !isManualMode) return;

    const onMove = (e: MouseEvent) => {
      const point = getImagePoint(e.clientX, e.clientY);
      if (!point) return;
      setDrawCurrent({ x: clamp01(point.x), y: clamp01(point.y) });
    };

    const onUp = (e: MouseEvent) => {
      const point = getImagePoint(e.clientX, e.clientY);
      const cur = point ? { x: clamp01(point.x), y: clamp01(point.y) } : drawCurrent ?? drawStart;

      const x1 = Math.min(drawStart.x, cur.x);
      const y1 = Math.min(drawStart.y, cur.y);
      const x2 = Math.max(drawStart.x, cur.x);
      const y2 = Math.max(drawStart.y, cur.y);

      if (x2 - x1 >= 0.02 && y2 - y1 >= 0.02) {
        setShowManualModal({
          x: x1,
          y: y1,
          width: x2 - x1,
          height: y2 - y1,
        });
      }

      setDrawStart(null);
      setDrawCurrent(null);
      setIsManualMode(false);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drawStart, drawCurrent, getImagePoint, isManualMode]);

  const getFaceOverlayStyle = (face: Photo['faces'][number]) => {
    if (!visiblePhoto.width || !visiblePhoto.height || viewSize.w === 0) return {};

    const fx1 = face.x1 ?? 0;
    const fy1 = face.y1 ?? 0;
    const fx2 = face.x2 ?? 0;
    const fy2 = face.y2 ?? 0;

    const x1 = (fx1 / visiblePhoto.width) * viewSize.w;
    const y1 = (fy1 / visiblePhoto.height) * viewSize.h;
    const w = ((fx2 - fx1) / visiblePhoto.width) * viewSize.w;
    const h = ((fy2 - fy1) / visiblePhoto.height) * viewSize.h;

    return { left: `${x1}px`, top: `${y1}px`, width: `${w}px`, height: `${h}px` };
  };

  const getDrawRectStyle = () => {
    if (!drawStart || !drawCurrent) return {};
    return {
      left: `${Math.min(drawStart.x, drawCurrent.x) * 100}%`,
      top: `${Math.min(drawStart.y, drawCurrent.y) * 100}%`,
      width: `${Math.abs(drawCurrent.x - drawStart.x) * 100}%`,
      height: `${Math.abs(drawCurrent.y - drawStart.y) * 100}%`,
    };
  };

  const getFaceThumbUrl = (result: SimilarResult) => {
    if (similarViewMode === 'photo') {
      return getGridThumbUrl(result.photo_path, 400) ?? '';
    }
    if (result.box && result.box.length >= 4 && result.photo_path) {
      const [x1, y1, x2, y2] = result.box;
      if (x2 > x1 && y2 > y1) {
        // Usar expand=0.4 para um melhor crop da face
        return api.faceThumbUrl(result.photo_path, x1, y1, x2, y2, 200, 0.4);
      }
    }
    return getGridThumbUrl(result.photo_path, 200) ?? '';
  };

  const getFaceImageStyle = (result: SimilarResult): React.CSSProperties => {
    if (similarViewMode === 'photo') {
      return { objectFit: 'contain', background: '#000' };
    }
    
    if (result.box && result.box.length >= 4 && result.image_width && result.image_height) {
      const [x1, y1, x2, y2] = result.box;
      const centerX = (x1 + x2) / 2;
      const centerY = (y1 + y2) / 2;
      const xPercent = (centerX / result.image_width) * 100;
      const yPercent = (centerY / result.image_height) * 100;
      return {
        objectFit: 'cover',
        objectPosition: `${xPercent}% ${yPercent}%`
      };
    }
    
    return { objectFit: 'cover', objectPosition: 'center 35%' };
  };

  return (
    <div className={`${styles.viewerOverlay} ${isDiscarded ? styles.discarded : ''}`} onClick={onClose}>
      {/* â”€â”€ Header â”€â”€ */}
      <div className={styles.header} onClick={(e) => e.stopPropagation()}>
        <span className={styles.headerTitle}>VisualizaÃ§Ã£o de Registro</span>
        <span className={styles.escBadge}>ESC p/ sair</span>
        <div className={styles.headerSpacer} />
        <div className={styles.headerActions}>
          <button
            className={`${styles.headerBtn} ${isManualMode ? styles.active : ''}`}
            onClick={() => setIsManualMode(!isManualMode)}
            title="Adicionar rosto manual"
          >
            <Plus size={13} />
            Adicionar Rosto
          </button>
          <button
            className={styles.headerBtn}
            onClick={() => {
              const sep = visiblePhoto.path.includes('\\') ? '\\' : '/';
              const folder = visiblePhoto.path.substring(0, visiblePhoto.path.lastIndexOf(sep));
              api.openFolder(folder);
            }}
            title="Abrir pasta"
          >
            <FolderOpen size={13} />
            Pasta
          </button>
          <button
            className={`${styles.headerBtn} ${styles.headerBtnPhotoshop}`}
            onClick={() => api.openPhotoshop(visiblePhoto.path)}
            title="Abrir no Photoshop (P)"
          >
            Photoshop (P)
          </button>
          <button
            className={`${styles.headerBtn} ${isDiscarded ? styles.headerBtnDanger : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              isDiscarded ? handleRestore() : handleDiscard();
            }}
          >
            {isDiscarded ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
            {isDiscarded ? 'Restaurar' : 'Descartar'}
          </button>
          <button className={styles.headerBtn} onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>

      {/* â”€â”€ Main â”€â”€ */}
      <div className={styles.main}>
        {/* Left panel â€” file info */}
        <div className={styles.leftPanel} onClick={(e) => e.stopPropagation()}>
          <div className={styles.fileInfoCard}>
            <div className={styles.fileInfoLabel}>ARQUIVO</div>
            <div className={styles.fileInfoName}>{visiblePhoto.name}</div>
          </div>
        </div>

        {/* Center â€” image */}
        <div className={styles.centerArea} onClick={(e) => e.stopPropagation()}>
          <div className={styles.viewerTopMeta}>
            <span className={styles.viewerTopName}>{visiblePhoto.name}</span>
        <span className={styles.viewerTopCounter}>{displayCounter} de {Math.max(total, 1)}</span>
          </div>

          {currentIndex > 0 && (
            <button className={`${styles.navBtn} ${styles.navPrev}`} onClick={handlePrev}>
              <ChevronLeft size={20} />
            </button>
          )}

          {currentIndex < total - 1 && (
            <button className={`${styles.navBtn} ${styles.navNext}`} onClick={handleNext}>
              <ChevronRight size={20} />
            </button>
          )}

          <div
            ref={imageStageRef}
            className={`${styles.imageStage} ${isManualMode ? styles.crosshair : ''}`}
            onMouseDown={handleZoomMouseDown}
            onDoubleClick={handleDoubleClickZoom}
            style={{
              cursor: zoom > 1 && !isManualMode ? (isDragging ? 'grabbing' : 'grab') : undefined,
            }}
          >
            <div
              className={styles.zoomLayer}
              style={{
                transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                transformOrigin: '0 0',
                transition: isDragging || isWheelZooming ? 'none' : 'transform 80ms ease-out',
                width: viewSize.w || 'auto',
                height: viewSize.h || 'auto',
              }}
            >
              <div className={styles.photoImageWrap} ref={imageWrapRef}>
                  <img
                    ref={imageRef}
                    src={displayedSrc}
                    alt={visiblePhoto.name}
                    className={styles.mainImage}
                  style={{ 
                    opacity: isLoaded ? 1 : 0,
                    imageRendering: zoom >= 1 ? 'auto' : 'auto'
                  }}
                  loading="eager"
                  fetchPriority="high"
                  decoding="async"
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    const stage = imageStageRef.current;
                    const maxW = stage?.clientWidth || 800;
                    const maxH = stage?.clientHeight || window.innerHeight - 130;
                    const nw = img.naturalWidth;
                    const nh = img.naturalHeight;
                    let w = nw;
                    let h = nh;
                    if (w > maxW) { w = maxW; h = (maxW / nw) * nh; }
                    if (h > maxH) { h = maxH; w = (maxH / nh) * nw; }
                    img.style.width = `${w}px`;
                    img.style.height = `${h}px`;
                    setViewSize({ w, h });
                    setPan({
                      x: (maxW - w) / 2,
                      y: (maxH - h) / 2
                    });
                    setIsLoaded(true);
                    if (viewerLoadStartRef.current !== null && !viewerLoggedRef.current) {
                      viewerLoggedRef.current = true;
                      logPerf(`viewer loaded ${viewerTransitionRef.current}`, viewerLoadStartRef.current, visiblePhoto.path);
                    }
                  }}
                  onError={() => {
                    const fallback = getViewerFallbackUrl(visiblePhoto);
                    if (displayedSrc === fallback) {
                      setIsLoaded(true);
                      return;
                    }
                    console.warn("[Viewer] fallback image_full para:", visiblePhoto.path);
                    setDisplayedSrc(fallback);
                    setIsLoaded(true);
                    if (viewerLoadStartRef.current !== null && !viewerLoggedRef.current) {
                      viewerLoggedRef.current = true;
                      logPerf(`viewer loaded ${viewerTransitionRef.current}`, viewerLoadStartRef.current, visiblePhoto.path);
                    }
                  }}
                />

                {isDiscarded && <div className={styles.discardBadge}>DESCARTADA</div>}

                {isLoaded && viewSize.w > 0 && visiblePhoto.width && visiblePhoto.height && (visiblePhoto.faces || []).map((face, faceIdx) => {
                  const isKnown = isKnownFace(face);
                  const overlayStyle = getFaceOverlayStyle(face);
                  const isMenuOpen = activeMenu === faceIdx;

                  return (
                    <div
                      key={face.rowid ?? faceIdx}
                      className={`${styles.faceOverlay} ${isKnown ? styles.known : ''}`}
                      style={overlayStyle}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveMenu(isMenuOpen ? null : faceIdx);
                      }}
                    >
                      <button
                        className={styles.faceMenuBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveMenu(isMenuOpen ? null : faceIdx);
                        }}
                      >
                        <Search size={10} />
                      </button>

                      {isMenuOpen && (
                        <div className={styles.faceMenu} onClick={(e) => e.stopPropagation()}>
                          <button className={styles.menuItem} onClick={() => {
                            setShowRenameModal(faceIdx);
                            setRenameValue(face.aluno_id ?? '');
                            setActiveMenu(null);
                          }}>
                            <UserCheck size={13} />
                            Renomear formando
                          </button>
                          <button className={styles.menuItem} onClick={() => handleSearchSimilar(faceIdx)}>
                            <Search size={13} />
                            Buscar semelhantes
                          </button>
                          <div className={styles.menuDivider} />
                          <button className={`${styles.menuItem} ${styles.menuItemDanger}`} onClick={() => handleRemoveIdent(faceIdx)}>
                            <UserMinus size={13} />
                            Remover identificação
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}

                {isManualMode && (
                  <div
                    className={styles.manualFaceOverlay}
                    onMouseDown={handleMouseDown}
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    {drawStart && drawCurrent && <div className={styles.manualFaceRect} style={getDrawRectStyle()} />}
                  </div>
                )}
              </div>
            </div>
          </div>

          {(contextLoading || contextBadge || total > 1) && (
            <div className={styles.contextRail} onClick={(e) => e.stopPropagation()}>
              {contextBadge && <div className={styles.contextBadge}>{contextBadge}</div>}
              {contextLoading && <div className={styles.contextLoading}>Carregando contexto...</div>}
              {total > 1 && (
                <div
                  ref={filmstripRef}
                  className={styles.filmstrip}
                  onScroll={() => {
                    filmstripUserScrollRef.current = true;
                    if (filmstripScrollTimerRef.current) {
                      window.clearTimeout(filmstripScrollTimerRef.current);
                    }
                    filmstripScrollTimerRef.current = window.setTimeout(() => {
                      filmstripUserScrollRef.current = false;
                      filmstripScrollTimerRef.current = null;
                    }, 180);
                  }}
                >
                  {navigationPhotos.map((item) => {
                    const isActive = item.path === visiblePhoto.path;
                    const itemKey = getViewerPhotoKey(item);
                    const aiResult = aiCacheStore.get(item.path);
                    const aiStatus = aiResult?.status;
                    const showAiBadge = aiStatus === "completed" && (aiResult?.face_detected || aiResult?.ocr_text);
                    return (
                      <button
                        key={itemKey}
                        type="button"
                        className={`${styles.filmstripItem} ${isActive ? styles.filmstripItemActive : ''} ${aiStatus === "processing" || aiStatus === "pending" ? styles.filmstripItemProcessing : ''}`}
                        ref={(node) => {
                          thumbRefs.current[itemKey] = node;
                        }}
                        onClick={() => onNavigate(item)}
                        title={item.name}
                      >
                        <img
                          src={getGridThumbUrl(item.path, 180) ?? ''}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className={styles.filmstripThumb}
                        />
                        {isActive && <span className={styles.filmstripLabel}>Atual</span>}
                        {showAiBadge && <span className={styles.filmstripAiBadge}><Brain size={10} /></span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right panel â€” identification */}
        <div className={styles.rightPanel} onClick={(e) => e.stopPropagation()}>
          <div className={styles.identHeader}>
            IDENTIFICAÃ‡ÃƒO {(visiblePhoto.faces || []).length > 0 && <span className={styles.identCount}>{(visiblePhoto.faces || []).length}</span>}
            <ChevronRight size={14} className={styles.identChevron} />
          </div>

          <div className={styles.identList}>
            {(visiblePhoto.faces || []).length === 0 && (
              <div style={{ padding: '20px', textAlign: 'center', color: '#475569', fontSize: '0.75rem' }}>
                Nenhum rosto detectado
              </div>
            )}
            {(visiblePhoto.faces || []).map((face, idx) => {
              const isKnown = isKnownFace(face);
              const name = face.aluno_id || 'Desconhecido';
              return (
                <div key={face.rowid ?? idx} className={styles.identItem}>
                  <div className={`${styles.identDot} ${isKnown ? styles.identDotKnown : styles.identDotUnknown}`} />
                  <span className={styles.identName}>{name}</span>
                  {!isKnown && (
                    <button
                      style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: 2 }}
                      onClick={() => {
                        setShowRenameModal(idx);
                        setRenameValue('');
                      }}
                    >
                      <UserCheck size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className={styles.identActions}>
            <button className={`${styles.sideActionBtn} ${styles.sideActionBtnPrimary}`} onClick={handleRestore}>
              <span className={styles.actionIcon}>
                <ArrowUp size={14} />
              </span>
              {isDiscarded ? 'RESTAURAR' : 'APROVAR'}
            </button>
            <button className={`${styles.sideActionBtn} ${styles.sideActionBtnDanger}`} onClick={handleDiscard}>
              <span className={styles.actionIconDanger}>
                <ArrowDown size={14} />
              </span>
              DESCARTAR
            </button>
          </div>
        </div>
      </div>

      {/* â”€â”€ Feedback toast â”€â”€ */}
      {feedback && <div className={styles.feedback}>{feedback}</div>}

      {/* â”€â”€ Rename modal â”€â”€ */}
      {showRenameModal !== null && (
        <div className={styles.modalOverlay} onClick={() => setShowRenameModal(null)}>
          <div className={styles.modalBox} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Vincular formando</h3>
            <input
              type="text"
              className={styles.modalInput}
              placeholder="Digite o nome do formando"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && renameValue && handleRename(showRenameModal)}
              autoFocus
            />
            <div className={styles.modalActions}>
              <button className={`${styles.modalBtn} ${styles.modalBtnCancel}`} onClick={() => setShowRenameModal(null)}>
                Cancelar
              </button>
              <button className={`${styles.modalBtn} ${styles.modalBtnPrimary}`} onClick={() => handleRename(showRenameModal)} disabled={!renameValue.trim()}>
                Vincular
              </button>
            </div>
          </div>
        </div>
      )}

      {/* â”€â”€ Manual face modal â”€â”€ */}
      {showManualModal && (
        <div className={styles.modalOverlay} onClick={() => setShowManualModal(null)}>
          <div className={styles.modalBox} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Vincular a qual formando?</h3>
            <input
              type="text"
              className={styles.modalInput}
              placeholder="Digite o nome do formando"
              value={manualAlunoId}
              onChange={(e) => setManualAlunoId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && manualAlunoId && handleAddManualFace()}
              autoFocus
            />
            <div className={styles.modalActions}>
              <button className={`${styles.modalBtn} ${styles.modalBtnCancel}`} onClick={() => setShowManualModal(null)}>
                Cancelar
              </button>
              <button className={`${styles.modalBtn} ${styles.modalBtnPrimary}`} onClick={handleAddManualFace} disabled={!manualAlunoId.trim()}>
                Adicionar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* â”€â”€ Similar results panel â”€â”€ */}
      {(similarResults.length > 0 || similarError) && (
        <div className={styles.modalOverlay} onClick={() => { setSimilarResults([]); setSimilarError(null); }}>
          <div className={styles.similarPanel} onClick={(e) => e.stopPropagation()}>
            <div className={styles.similarHeader}>
              <div className={styles.similarTitleGroup}>
                <h3 className={styles.modalTitle}>Faces semelhantes</h3>
                <span className={styles.similarCount}>{similarResults.length} encontradas</span>
              </div>

              {!similarError && (
                <div className={styles.similarViewToggle}>
                  <button 
                    className={`${styles.toggleBtn} ${similarViewMode === 'face' ? styles.toggleActive : ''}`}
                    onClick={() => setSimilarViewMode('face')}
                  >
                    Rosto
                  </button>
                  <button 
                    className={`${styles.toggleBtn} ${similarViewMode === 'photo' ? styles.toggleActive : ''}`}
                    onClick={() => setSimilarViewMode('photo')}
                  >
                    Foto
                  </button>
                </div>
              )}

              <button className={styles.similarClose} onClick={() => { setSimilarResults([]); setSimilarError(null); }}>
                <X size={16} />
              </button>
            </div>

            {!similarError && (
              <div className={styles.similarActions}>
                <div className={styles.similarSelectionControls}>
                  <button 
                    className={styles.textBtn}
                    onClick={() => setSelectedSimilarIds(new Set(similarResults.map(r => r.rowid)))}
                  >
                    Selecionar todas
                  </button>
                  <button 
                    className={styles.textBtn}
                    onClick={() => setSelectedSimilarIds(new Set())}
                  >
                    Limpar seleÃ§Ã£o
                  </button>
                </div>
                
                <div className={styles.similarApplyForm}>
                  <input
                    type="text"
                    className={styles.similarInput}
                    placeholder="Vincular ao formando..."
                    value={similarName}
                    onChange={(e) => setSimilarName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleApplySimilarName()}
                  />
                  <button 
                    className={styles.applyBtn}
                    onClick={handleApplySimilarName}
                    disabled={!similarName.trim() || applyingSimilarName}
                  >
                    {applyingSimilarName ? 'Aplicando...' : 'Aplicar nome'}
                  </button>
                </div>
              </div>
            )}

            {similarError ? (
              <div className={styles.similarLoading}>{similarError}</div>
            ) : (
              <div className={styles.similarGrid}>
                {similarResults.map((result) => {
                  const isSelected = selectedSimilarIds.has(result.rowid);
                  return (
                    <div 
                      key={result.rowid} 
                      className={`${styles.similarItem} ${isSelected ? styles.selected : ''}`}
                      onClick={() => toggleSimilarSelection(result.rowid)}
                    >
                      <div className={styles.similarImgWrap}>
                        <img 
                          src={getFaceThumbUrl(result)} 
                          alt="" 
                          className={styles.similarImg} 
                          style={getFaceImageStyle(result)}
                        />
                        {isSelected && (
                          <div className={styles.itemCheck}>
                            <UserCheck size={14} />
                          </div>
                        )}
                      </div>
                      <div className={styles.similarScore}>
                        {result.aluno_id ?? 'Desconhecido'} Â· {(result.score * 100).toFixed(0)}%
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {similarLoading && (
        <div className={styles.modalOverlay}>
          <div className={styles.similarPanel} onClick={(e) => e.stopPropagation()}>
            <div className={styles.similarLoading}>Buscando faces semelhantes...</div>
          </div>
        </div>
      )}
    </div>
  );
}


