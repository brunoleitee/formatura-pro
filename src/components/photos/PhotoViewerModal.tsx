import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, Search, UserCheck, UserMinus, Plus, ArrowUp, ArrowDown, FolderOpen } from 'lucide-react';
import { api, type Photo } from '../../services/api';
import { isKnownFace } from '../../utils/personIdentity';
import { useApp } from '../../context/AppContext';
import styles from './PhotoViewerModal.module.css';

interface PhotoViewerModalProps {
  photo: Photo;
  allPhotos: Photo[];
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

export function PhotoViewerModal({ photo, allPhotos, onClose, onNavigate, onPhotoUpdate, onDiscard, onRestore }: PhotoViewerModalProps) {
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
  const [showManualModal, setShowManualModal] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [manualAlunoId, setManualAlunoId] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartPos, setDragStartPos] = useState({ x: 0, y: 0 });

  // Alta qualidade dinâmica
  const [useHighRes, setUseHighRes] = useState(false);
  const [highResLoaded, setHighResLoaded] = useState(false);
  const [currentSrc, setCurrentSrc] = useState(api.thumbUrl(photo.path, 1200, 90));

  useEffect(() => {
    // Reset quando troca de foto
    setIsLoaded(false);
    setUseHighRes(false);
    setHighResLoaded(false);
    setCurrentSrc(api.thumbUrl(photo.path, 1200, 90));
  }, [photo.path]);

  useEffect(() => {
    // Se zoom for alto, carregar original
    if (zoom >= 1.0 && !useHighRes) {
      setUseHighRes(true);
      const img = new window.Image();
      const highResUrl = api.fullResUrl(photo.path);
      img.src = highResUrl;
      img.onload = () => {
        setCurrentSrc(highResUrl);
        setHighResLoaded(true);
      };
    }
  }, [zoom, photo.path, useHighRes]);

  const imageRef = useRef<HTMLImageElement>(null);
  const imageStageRef = useRef<HTMLDivElement>(null);
  const currentIndex = allPhotos.findIndex((p) => p.path === photo.path);
  const total = allPhotos.length;
  const isDiscarded = photo.discarded;

  const clamp = (val: number, min: number, max: number) => Math.min(Math.max(val, min), max);

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

  const handleDiscard = async () => {
    try {
      await api.discardPhoto({ foto_path: photo.path, discard: true });
      showFeedbackMsg("Foto descartada");
      onDiscard?.(photo.path);
      if (currentIndex < total - 1) onNavigate(allPhotos[currentIndex + 1]);
    } catch (err) {
      console.error("Erro ao descartar:", err);
    }
  };

  const handleRestore = async () => {
    try {
      await api.discardPhoto({ foto_path: photo.path, discard: false });
      showFeedbackMsg("Foto restaurada");
      onRestore?.(photo.path);
    } catch (err) {
      console.error("Erro ao restaurar:", err);
    }
  };

  const handleRename = async (faceIdx: number) => {
    const face = photo.faces?.[faceIdx];
    if (!face) return;
    try {
      await api.bulkManualIdentify(currentCatalog, renameValue, face.rowid ? [face.rowid] : []);
      showFeedbackMsg(`Vinculado: ${renameValue}`);
      setShowRenameModal(null);
      setRenameValue('');
      onPhotoUpdate?.({ ...photo });
    } catch (err) {
      console.error("Erro ao renomear:", err);
      showFeedbackMsg("Erro ao vincular");
    }
  };

  const handleRemoveIdent = async (faceIdx: number) => {
    const face = photo.faces?.[faceIdx];
    if (!face) return;
    try {
      await api.bulkManualIdentify(currentCatalog, 'Desconhecido', face.rowid ? [face.rowid] : []);
      showFeedbackMsg("Identificação removida");
      setActiveMenu(null);
      onPhotoUpdate?.({ ...photo });
    } catch (err) {
      console.error("Erro ao remover:", err);
    }
  };

  const handleSearchSimilar = async (faceIdx: number) => {
    const face = photo.faces?.[faceIdx];
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
      showFeedbackMsg(`Vínculo aplicado a ${rowids.length} faces`);
      
      setSimilarResults(prev => prev.map(r => 
        rowids.includes(r.rowid) ? { ...r, aluno_id: similarName.trim() } : r
      ));
      
      setSelectedSimilarIds(new Set());
      setSimilarName('');
      onPhotoUpdate?.({ ...photo });
    } catch (err) {
      console.error("Erro ao aplicar nome em lote:", err);
      showFeedbackMsg("Erro ao aplicar nome");
    } finally {
      setApplyingSimilarName(false);
    }
  };

  const handleAddManualFace = async () => {
    if (!manualAlunoId.trim() || !showManualModal) return;
    try {
      await api.addManualFace({
        photo_id: (photo as any).rowid ?? 0,
        photo_path: photo.path,
        aluno_id: manualAlunoId.trim(),
        bbox: showManualModal,
        source: 'manual'
      });
      showFeedbackMsg("Rosto manual adicionado");
      setShowManualModal(null);
      setManualAlunoId('');
      setIsManualMode(false);
      onPhotoUpdate?.({ ...photo });
    } catch (err) {
      console.error("Erro ao adicionar rosto manual:", err);
      showFeedbackMsg("Erro ao adicionar rosto");
    }
  };

  useEffect(() => {
    setZoom(1);
    // Initial pan will be set in onLoad when image size is known
  }, [photo.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showRenameModal !== null || similarResults.length > 0 || showManualModal) return;
      
      if (e.key === 'p' || e.key === 'P') {
        api.openPhotoshop(photo.path);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        handleRestore();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        handleDiscard();
      } else if (e.key === 'ArrowLeft') {
        if (currentIndex > 0) onNavigate(allPhotos[currentIndex - 1]);
      } else if (e.key === 'ArrowRight') {
        if (currentIndex < total - 1) onNavigate(allPhotos[currentIndex + 1]);
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

  function handleWheelZoom(e: React.WheelEvent) {
    if (isManualMode || showRenameModal !== null || similarResults.length > 0 || showManualModal) return;
    
    e.preventDefault();
    e.stopPropagation();

    const rect = imageStageRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nextZoom = clamp(zoom * zoomFactor, 1, 8);

    if (nextZoom === zoom) return;

    const scaleChange = nextZoom / zoom;

    setPan(prev => {
      const newPan = {
        x: mouseX - (mouseX - prev.x) * scaleChange,
        y: mouseY - (mouseY - prev.y) * scaleChange,
      };
      
      if (nextZoom === 1) {
        return calculateInitialPan(viewSize.w, viewSize.h);
      }
      return newPan;
    });

    setZoom(nextZoom);
  }

  const handleDoubleClickZoom = (e: React.MouseEvent) => {
    if (isManualMode || showRenameModal !== null || similarResults.length > 0 || showManualModal) return;

    if (zoom > 1) {
      setZoom(1);
      setPan(calculateInitialPan(viewSize.w, viewSize.h));
    } else {
      const rect = imageStageRef.current?.getBoundingClientRect();
      if (!rect) return;

      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const nextZoom = 2;
      const scaleChange = nextZoom / zoom;

      setPan(prev => ({
        x: mouseX - (mouseX - prev.x) * scaleChange,
        y: mouseY - (mouseY - prev.y) * scaleChange,
      }));
      setZoom(nextZoom);
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

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentIndex > 0) onNavigate(allPhotos[currentIndex - 1]);
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentIndex < total - 1) onNavigate(allPhotos[currentIndex + 1]);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isManualMode || !imageRef.current) return;
    const rect = imageRef.current.getBoundingClientRect();
    setDrawStart({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setDrawCurrent(null);
  };

  useEffect(() => {
    if (!drawStart || !isManualMode) return;

    const onMove = (e: MouseEvent) => {
      if (!imageRef.current) return;
      const rect = imageRef.current.getBoundingClientRect();
      setDrawCurrent({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    };

    const onUp = (e: MouseEvent) => {
      if (!imageRef.current) {
        setDrawStart(null);
        setDrawCurrent(null);
        return;
      }
      const rect = imageRef.current.getBoundingClientRect();
      const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      const x1 = Math.min(drawStart.x, cur.x);
      const y1 = Math.min(drawStart.y, cur.y);
      const x2 = Math.max(drawStart.x, cur.x);
      const y2 = Math.max(drawStart.y, cur.y);

      if (x2 - x1 >= 20 && y2 - y1 >= 20 && photo.width && photo.height) {
        setShowManualModal({
          x1: (x1 / rect.width) * photo.width,
          y1: (y1 / rect.height) * photo.height,
          x2: (x2 / rect.width) * photo.width,
          y2: (y2 / rect.height) * photo.height,
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
  }, [drawStart, isManualMode, photo.width, photo.height]);

  const getFaceOverlayStyle = (face: Photo['faces'][number]) => {
    if (!photo.width || !photo.height || viewSize.w === 0) return {};

    const fx1 = face.x1 ?? 0;
    const fy1 = face.y1 ?? 0;
    const fx2 = face.x2 ?? 0;
    const fy2 = face.y2 ?? 0;

    const x1 = (fx1 / photo.width) * viewSize.w;
    const y1 = (fy1 / photo.height) * viewSize.h;
    const w = ((fx2 - fx1) / photo.width) * viewSize.w;
    const h = ((fy2 - fy1) / photo.height) * viewSize.h;

    return { left: `${x1}px`, top: `${y1}px`, width: `${w}px`, height: `${h}px` };
  };

  const getDrawRectStyle = () => {
    if (!drawStart || !drawCurrent) return {};
    return {
      left: `${Math.min(drawStart.x, drawCurrent.x)}px`,
      top: `${Math.min(drawStart.y, drawCurrent.y)}px`,
      width: `${Math.abs(drawCurrent.x - drawStart.x)}px`,
      height: `${Math.abs(drawCurrent.y - drawStart.y)}px`,
    };
  };

  const getFaceThumbUrl = (result: SimilarResult) => {
    if (similarViewMode === 'photo') {
      return result.photo_path ? api.thumbUrl(result.photo_path, 400) : '';
    }
    if (result.box && result.box.length >= 4 && result.photo_path) {
      const [x1, y1, x2, y2] = result.box;
      if (x2 > x1 && y2 > y1) {
        // Usar expand=0.4 para um melhor crop da face
        return api.faceThumbUrl(result.photo_path, x1, y1, x2, y2, 200, 0.4);
      }
    }
    return result.photo_path ? api.thumbUrl(result.photo_path, 200) : '';
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
      {/* ── Header ── */}
      <div className={styles.header} onClick={(e) => e.stopPropagation()}>
        <span className={styles.headerTitle}>Visualização de Registro</span>
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
              const sep = photo.path.includes('\\') ? '\\' : '/';
              const folder = photo.path.substring(0, photo.path.lastIndexOf(sep));
              api.openFolder(folder);
            }}
            title="Abrir pasta"
          >
            <FolderOpen size={13} />
            Pasta
          </button>
          <button
            className={`${styles.headerBtn} ${styles.headerBtnPhotoshop}`}
            onClick={() => api.openPhotoshop(photo.path)}
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

      {/* ── Main ── */}
      <div className={styles.main}>
        {/* Left panel — file info */}
        <div className={styles.leftPanel} onClick={(e) => e.stopPropagation()}>
          <div className={styles.fileInfoCard}>
            <div className={styles.fileInfoLabel}>ARQUIVO</div>
            <div className={styles.fileInfoName}>{photo.name}</div>
          </div>
        </div>

        {/* Center — image */}
        <div className={styles.centerArea} onClick={(e) => e.stopPropagation()}>
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
            onWheel={handleWheelZoom}
            onMouseDown={handleZoomMouseDown}
            onDoubleClick={handleDoubleClickZoom}
            style={{
              cursor: zoom > 1 && !isManualMode ? (isDragging ? 'grabbing' : 'grab') : undefined,
            }}
          >
            <div
              className={styles.zoomLayer}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: '0 0',
                transition: isDragging ? 'none' : 'transform 80ms ease-out',
                width: viewSize.w || 'auto',
                height: viewSize.h || 'auto',
              }}
            >
              <img
                ref={imageRef}
                src={currentSrc}
                alt={photo.name}
                className={styles.mainImage}
                style={{ 
                  opacity: isLoaded ? 1 : 0,
                  imageRendering: zoom >= 1 ? 'auto' : 'auto'
                }}
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
                }}
              />

              {useHighRes && !highResLoaded && (
                <div className={styles.highResIndicator}>
                  <div className={styles.highResSpinner} />
                  <span>Alta Qualidade...</span>
                </div>
              )}

              {isDiscarded && <div className={styles.discardBadge}>DESCARTADA</div>}

              {isLoaded && viewSize.w > 0 && photo.width && photo.height && (photo.faces || []).map((face, faceIdx) => {
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

              {drawStart && drawCurrent && <div className={styles.drawingRect} style={getDrawRectStyle()} />}
            </div>
            {isManualMode && <div className={styles.drawHint}>Arraste para marcar o formando</div>}
          </div>
        </div>

        {/* Right panel — identification */}
        <div className={styles.rightPanel} onClick={(e) => e.stopPropagation()}>
          <div className={styles.identHeader}>
            IDENTIFICAÇÃO {(photo.faces || []).length > 0 && <span className={styles.identCount}>{(photo.faces || []).length}</span>}
            <ChevronRight size={14} className={styles.identChevron} />
          </div>

          <div className={styles.identList}>
            {(photo.faces || []).length === 0 && (
              <div style={{ padding: '20px', textAlign: 'center', color: '#475569', fontSize: '0.75rem' }}>
                Nenhum rosto detectado
              </div>
            )}
            {(photo.faces || []).map((face, idx) => {
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

      {/* ── Feedback toast ── */}
      {feedback && <div className={styles.feedback}>{feedback}</div>}

      {/* ── Rename modal ── */}
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

      {/* ── Manual face modal ── */}
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

      {/* ── Similar results panel ── */}
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
                    Limpar seleção
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
                        {result.aluno_id ?? 'Desconhecido'} · {(result.score * 100).toFixed(0)}%
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