import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, Search, UserCheck, UserMinus, Plus } from 'lucide-react';
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
  const [showManualModal, setShowManualModal] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [manualAlunoId, setManualAlunoId] = useState('');

  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentIndex = allPhotos.findIndex((p) => p.path === photo.path);
  const total = allPhotos.length;
  const isDiscarded = photo.discarded;

  const showFeedback = useCallback((text: string) => {
    setFeedback(text);
    setTimeout(() => setFeedback(null), 2000);
  }, []);

  const handleDiscard = async () => {
    try {
      await api.discardPhoto({ foto_path: photo.path, discard: true });
      showFeedback("Foto descartada");
      onDiscard?.(photo.path);
      if (currentIndex < total - 1) onNavigate(allPhotos[currentIndex + 1]);
    } catch (err) {
      console.error("Erro ao descartar:", err);
    }
  };

  const handleRestore = async () => {
    try {
      await api.discardPhoto({ foto_path: photo.path, discard: false });
      showFeedback("Foto restaurada");
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
      showFeedback(`Formando vinculado: ${renameValue}`);
      setShowRenameModal(null);
      setRenameValue('');
      onPhotoUpdate?.({ ...photo });
    } catch (err) {
      console.error("Erro ao renomear:", err);
      showFeedback("Erro ao vincular");
    }
  };

  const handleRemoveIdent = async (faceIdx: number) => {
    const face = photo.faces?.[faceIdx];
    if (!face) return;
    try {
      await api.bulkManualIdentify(currentCatalog || '', 'Desconhecido', face.rowid ? [face.rowid] : []);
      showFeedback("Identificação removida");
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
    setActiveMenu(null);
    try {
      const results = await api.searchSimilarFaces(face.rowid ?? 0, 50);
      setSimilarResults(results.results ?? []);
    } catch (err) {
      console.error("Erro ao buscar semelhantes:", err);
      showFeedback("Erro ao buscar semelhantes");
    } finally {
      setSimilarLoading(false);
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
      showFeedback("Rosto manual adicionado");
      setShowManualModal(null);
      setManualAlunoId('');
      setIsManualMode(false);
      onPhotoUpdate?.({ ...photo });
    } catch (err) {
      console.error("Erro ao adicionar rosto manual:", err);
      showFeedback("Erro ao adicionar rosto");
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showRenameModal !== null || similarResults.length > 0 || showManualModal) return;
      
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        handleDiscard();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        handleRestore();
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
  }, [photo, currentIndex, total, onNavigate, onClose, isManualMode, showRenameModal, similarResults.length, showManualModal]);

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
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isManualMode || !drawStart || !imageRef.current) return;
    const rect = imageRef.current.getBoundingClientRect();
    setDrawCurrent({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const handleMouseUp = () => {
    if (!isManualMode || !drawStart || !drawCurrent || !imageRef.current) return;
    
    const x1 = Math.min(drawStart.x, drawCurrent.x);
    const y1 = Math.min(drawStart.y, drawCurrent.y);
    const x2 = Math.max(drawStart.x, drawCurrent.x);
    const y2 = Math.max(drawStart.y, drawCurrent.y);
    
    const width = x2 - x1;
    const height = y2 - y1;
    
    if (width >= 20 && height >= 20 && imageRef.current.naturalWidth) {
      const normX1 = x1 / imageRef.current.naturalWidth;
      const normY1 = y1 / imageRef.current.naturalHeight;
      const normX2 = x2 / imageRef.current.naturalWidth;
      const normY2 = y2 / imageRef.current.naturalHeight;
      
      setShowManualModal({ x1: normX1, y1: normY1, x2: normX2, y2: normY2 });
    }
    
    setDrawStart(null);
    setDrawCurrent(null);
    setIsManualMode(false);
  };

  const getFaceOverlayStyle = (face: Photo['faces'][number]) => {
    if (!photo.width || !photo.height || viewSize.w === 0) return {};

    const imgRatio = photo.width / photo.height;
    const containerRatio = viewSize.w / viewSize.h;

    let renderedW = viewSize.w;
    let renderedH = viewSize.h;

    if (imgRatio > containerRatio) {
      renderedH = viewSize.w / imgRatio;
    } else {
      renderedW = viewSize.h * imgRatio;
    }

    const offsetX = (viewSize.w - renderedW) / 2;
    const offsetY = (viewSize.h - renderedH) / 2;

    const x1 = offsetX + ((face.x1 ?? 0) / photo.width) * renderedW;
    const y1 = offsetY + ((face.y1 ?? 0) / photo.height) * renderedH;
    const widthPx = ((face.x2 ?? 0 - (face.x1 ?? 0)) / photo.width) * renderedW;
    const heightPx = ((face.y2 ?? 0 - (face.y1 ?? 0)) / photo.height) * renderedH;

    return {
      left: `${x1}px`,
      top: `${y1}px`,
      width: `${widthPx}px`,
      height: `${heightPx}px`,
    };
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

  return (
    <div className={styles.viewerModal} onClick={onClose}>
      <div className={styles.viewerContent} onClick={(e) => e.stopPropagation()}>
        <button className={styles.viewerClose} onClick={onClose}>
          <X size={20} />
        </button>
        {isDiscarded && <div className={styles.discardBadge}>DESCARTADA</div>}
        
        <div className={styles.toolbar}>
          <button
            className={`${styles.toolBtn} ${isManualMode ? styles.active : ''}`}
            onClick={() => setIsManualMode(!isManualMode)}
            title="Adicionar rosto manualmente"
          >
            <Plus size={14} />
            Adicionar rosto
          </button>
        </div>

        <div 
          ref={containerRef}
          className={`${styles.imageWrap} ${isManualMode ? styles.crosshair : ''}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            if (drawStart) {
              setDrawStart(null);
              setDrawCurrent(null);
            }
          }}
        >
          {currentIndex > 0 && (
            <button className={`${styles.navBtn} ${styles.navPrev}`} onClick={handlePrev}>
              <ChevronLeft size={24} />
            </button>
          )}
          
          <img
            ref={imageRef}
            src={api.thumbUrl(photo.path, 1200)}
            alt={photo.name}
            style={{ opacity: isLoaded ? 1 : 0 }}
            onLoad={(e) => {
              setIsLoaded(true);
              setViewSize({ w: e.currentTarget.clientWidth, h: e.currentTarget.clientHeight });
            }}
          />
          
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
                  <Search size={12} />
                </button>
                
                {isMenuOpen && (
                  <div className={styles.faceMenu} onClick={(e) => e.stopPropagation()}>
                    <button
                      className={styles.menuItem}
                      onClick={() => {
                        setShowRenameModal(faceIdx);
                        setRenameValue(face.aluno_id ?? '');
                        setActiveMenu(null);
                      }}
                    >
                      <UserCheck size={14} />
                      Renomear formando
                    </button>
                    <button
                      className={styles.menuItem}
                      onClick={() => handleSearchSimilar(faceIdx)}
                    >
                      <Search size={14} />
                      Buscar semelhantes
                    </button>
                    <div className={styles.faceMenuDivider} />
                    <button
                      className={`${styles.menuItem} ${styles.danger}`}
                      onClick={() => handleRemoveIdent(faceIdx)}
                    >
                      <UserMinus size={14} />
                      Remover identificação
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {drawStart && drawCurrent && (
            <div className={styles.drawingRect} style={getDrawRectStyle()} />
          )}

          {isManualMode && (
            <div className={styles.drawHint}>Arraste para marcar o formando</div>
          )}

          {currentIndex < total - 1 && (
            <button className={`${styles.navBtn} ${styles.navNext}`} onClick={handleNext}>
              <ChevronRight size={24} />
            </button>
          )}

          {feedback && (
            <div className={styles.feedback}>{feedback}</div>
          )}
        </div>

        <div className={styles.footer}>
          <span className={styles.viewerName}>{photo.name}</span>
          <span className={styles.viewerCounter}>
            {currentIndex + 1} / {total}
          </span>
        </div>
      </div>

      {showRenameModal !== null && (
        <div className={styles.modal} onClick={() => setShowRenameModal(null)}>
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
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
              <button
                className={`${styles.modalBtn} ${styles.modalBtnCancel}`}
                onClick={() => setShowRenameModal(null)}
              >
                Cancelar
              </button>
              <button
                className={`${styles.modalBtn} ${styles.modalBtnPrimary}`}
                onClick={() => handleRename(showRenameModal)}
                disabled={!renameValue.trim()}
              >
                Vincular
              </button>
            </div>
          </div>
        </div>
      )}

      {showManualModal && (
        <div className={styles.modal} onClick={() => setShowManualModal(null)}>
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
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
              <button
                className={`${styles.modalBtn} ${styles.modalBtnCancel}`}
                onClick={() => setShowManualModal(null)}
              >
                Cancelar
              </button>
              <button
                className={`${styles.modalBtn} ${styles.modalBtnPrimary}`}
                onClick={handleAddManualFace}
                disabled={!manualAlunoId.trim()}
              >
                Adicionar
              </button>
            </div>
          </div>
        </div>
      )}

      {similarResults.length > 0 && (
        <div className={styles.modal} onClick={() => setSimilarResults([])}>
          <div className={styles.similarPanel} onClick={(e) => e.stopPropagation()}>
            <div className={styles.similarHeader}>
              <h3 className={styles.similarTitle}>Faces semelhantes</h3>
              <button className={styles.similarClose} onClick={() => setSimilarResults([])}>
                <X size={18} />
              </button>
            </div>
            <div className={styles.similarGrid}>
              {similarResults.map((result) => (
                <div key={result.rowid} className={styles.similarItem}>
                  <img src={result.thumb_url || api.thumbUrl(result.photo_path, 150)} alt="" className={styles.similarImg} />
                  <div className={styles.similarScore}>
                    {result.aluno_id ?? 'Desconhecido'} - {(result.score * 100).toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {similarLoading && (
        <div className={styles.modal} onClick={() => {}}>
          <div className={styles.similarPanel} onClick={(e) => e.stopPropagation()}>
            <div className={styles.similarLoading}>Buscando faces semelhantes...</div>
          </div>
        </div>
      )}
    </div>
  );
}

