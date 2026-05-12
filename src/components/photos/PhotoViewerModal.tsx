import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, Search, UserCheck, UserMinus, Plus, ThumbsUp, ThumbsDown } from 'lucide-react';
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
  const currentIndex = allPhotos.findIndex((p) => p.path === photo.path);
  const total = allPhotos.length;
  const isDiscarded = photo.discarded;

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
    setActiveMenu(null);
    try {
      const results = await api.searchSimilarFaces(face.rowid ?? 0, 50);
      setSimilarResults(results.results ?? []);
    } catch (err) {
      console.error("Erro ao buscar semelhantes:", err);
      showFeedbackMsg("Erro ao buscar semelhantes");
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
    const onKey = (e: KeyboardEvent) => {
      if (showRenameModal !== null || similarResults.length > 0 || showManualModal) return;
      
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (isDiscarded) handleRestore();
        else handleRestore();
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
  }, [photo, currentIndex, total, onNavigate, onClose, isManualMode, showRenameModal, similarResults.length, showManualModal, isDiscarded, handleRestore, handleDiscard]);

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
            className={`${styles.headerBtn} ${isDiscarded ? styles.headerBtnDanger : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              isDiscarded ? handleRestore() : handleDiscard();
            }}
          >
            {isDiscarded ? <ThumbsUp size={13} /> : <ThumbsDown size={13} />}
            {isDiscarded ? 'Restaurar' : 'Descartar'}
          </button>
          <button className={styles.headerBtn} onClick={onClose}>
            <X size={14} />
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

            <img
              ref={imageRef}
              src={api.thumbUrl(photo.path, 1200)}
              alt={photo.name}
              className={styles.mainImage}
              style={{ opacity: isLoaded ? 1 : 0 }}
              onLoad={(e) => {
                const img = e.currentTarget;
                const maxW = img.parentElement?.clientWidth || 800;
                const maxH = window.innerHeight - 130;
                const nw = img.naturalWidth;
                const nh = img.naturalHeight;
                let w = nw;
                let h = nh;
                if (w > maxW) { w = maxW; h = (maxW / nw) * nh; }
                if (h > maxH) { h = maxH; w = (maxH / nh) * nw; }
                img.style.width = `${w}px`;
                img.style.height = `${h}px`;
                setViewSize({ w, h });
                setIsLoaded(true);
              }}
            />

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
            {isManualMode && <div className={styles.drawHint}>Arraste para marcar o formando</div>}
          </div>
        </div>

        {/* Right panel — identification */}
        <div className={styles.rightPanel} onClick={(e) => e.stopPropagation()}>
          <div className={styles.identHeader}>IDENTIFICAÇÃO</div>

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
              <ThumbsUp size={14} />
              {isDiscarded ? 'Restaurar' : 'Aprovar'}
              <span className={styles.shortcut}>↑</span>
            </button>
            <button className={`${styles.sideActionBtn} ${styles.sideActionBtnDanger}`} onClick={handleDiscard}>
              <ThumbsDown size={14} />
              Descartar
              <span className={styles.shortcut}>↓</span>
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
      {similarResults.length > 0 && (
        <div className={styles.modalOverlay} onClick={() => setSimilarResults([])}>
          <div className={styles.similarPanel} onClick={(e) => e.stopPropagation()}>
            <div className={styles.similarHeader}>
              <h3 className={styles.modalTitle}>Faces semelhantes</h3>
              <button className={styles.similarClose} onClick={() => setSimilarResults([])}>
                <X size={16} />
              </button>
            </div>
            <div className={styles.similarGrid}>
              {similarResults.map((result) => (
                <div key={result.rowid} className={styles.similarItem}>
                  <img src={result.thumb_url || api.thumbUrl(result.photo_path, 150)} alt="" className={styles.similarImg} />
                  <div className={styles.similarScore}>
                    {result.aluno_id ?? 'Desconhecido'} · {(result.score * 100).toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>
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