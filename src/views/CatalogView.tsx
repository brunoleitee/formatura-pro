import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, ShieldCheck, Keyboard, X } from 'lucide-react';
import { api, catalogApi, type Photo, type QualityAuditStatus } from '../services/api';
import { useApp } from '../context/AppContext';
import { useCatalogPhotos } from '../hooks/useCatalogPhotos';
import { usePhotoFilters } from '../hooks/usePhotoFilters';
import { usePhotoSelection, getPhotoId } from '../hooks/usePhotoSelection';
import { usePhotoViewer } from '../hooks/usePhotoViewer';
import { PhotoDetailPanel } from '../components/photos/PhotoDetailPanel';
import { PhotoViewerModal } from '../components/photos/PhotoViewerModal';
import { PhotoFilters } from '../components/photos/PhotoFilters';
import { ZoomControl } from '../components/photos/ZoomControl';
import PhotoBulkActionsBar from '../components/photos/PhotoBulkActionsBar';
import { VirtualizedPhotoGrid } from '../components/photos/VirtualizedPhotoGrid';
import { extractSubfolders } from '../utils/pathUtils';
import { getPhotoPath, normalizePath, findCommonPrefix } from '../utils/catalogPathUtils';
import { logPerf, perfNow } from '../utils/perf';

const ZOOM_MIN = 100;
const ZOOM_MAX = 300;
const QUALITY_AUDIT_IDLE_STATUS: QualityAuditStatus = {
  status: 'idle',
  running: false,
  enabled: false,
  processed: 0,
  total: 0,
  progress: 0,
  message: 'Quality audit não iniciado',
  is_auditing: false,
  status_text: 'Quality audit não iniciado',
};

function zoomToSize(zoom: number) {
  return ZOOM_MIN + (zoom / 100) * (ZOOM_MAX - ZOOM_MIN);
}

const HOTKEYS_GRID = [
  { key: '← →', desc: 'Navegar entre fotos' },
  { key: 'Espaço', desc: 'Abrir viewer' },
  { key: 'Enter', desc: 'Abrir foto selecionada' },
  { key: 'D', desc: 'Descartar selecionadas' },
];

const HOTKEYS_VIEWER = [
  { key: '← →', desc: 'Foto anterior / próxima' },
  { key: 'Esc / Espaço', desc: 'Fechar viewer' },
  { key: 'Delete / ↓', desc: 'Descartar foto' },
  { key: '↑', desc: 'Restaurar foto' },
  { key: '1–5', desc: 'Avaliar com estrelas' },
  { key: 'F', desc: 'Favoritar' },
  { key: 'Enter', desc: 'Confirmar sugestão IA' },
];

export default function CatalogView() {
  const { currentCatalog, catalogSubfolder, setCatalogSubfolders, setIsLoadingCatalogPhotos } = useApp();
  const { photos, loading, loadingMore, hasMore, loadPhotos, loadMore, discardPhoto, restorePhoto } = useCatalogPhotos();
  const [hideDiscarded, setHideDiscarded] = useState(false);
  const [zoom, setZoom] = useState(60);
  const size = zoomToSize(zoom);
  const { filteredPhotos, filter, setFilter } = usePhotoFilters(photos, currentCatalog, catalogSubfolder, hideDiscarded);
  const { selectedPaths, toggleSelection, clearSelection } = usePhotoSelection(filteredPhotos);
  const { viewerPhoto, setViewerPhoto } = usePhotoViewer(filteredPhotos);
  const [bulkBarVisible, setBulkBarVisible] = useState(false);
  const [, setIsDraggingPhoto] = useState(false);
  const [auditStatus, setAuditStatus] = useState<QualityAuditStatus | null>(null);
  const [auditStarting, setAuditStarting] = useState(false);
  const [detailsPhoto, setDetailsPhoto] = useState<Photo | null>(null);
  const [showHotkeys, setShowHotkeys] = useState(false);

  const firstThumbLoadStartRef = useRef<number | null>(null);
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  const savedScrollRef = useRef(0);
  const firstThumbLoggedRef = useRef(false);
  const selectionCountRef = useRef(0);
  const getSelectionCount = useCallback(() => selectionCountRef.current, []);

  useEffect(() => {
    selectionCountRef.current = selectedPaths.size;
  }, [selectedPaths.size]);

  const handleDiscardSelected = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    const paths = Array.from(selectedPaths);
    paths.forEach(p => discardPhoto(p));
    clearSelection();
    try {
      await api.bulkDiscardPhotos(currentCatalog, paths);
      loadPhotos();
    } catch (e) { 
      console.error(e);
      loadPhotos();
    }
  }, [selectedPaths, currentCatalog, discardPhoto, clearSelection, loadPhotos]);

  const handleRestoreSelected = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    const paths = Array.from(selectedPaths);
    paths.forEach(p => restorePhoto(p));
    clearSelection();
    try {
      await api.bulkRestorePhotos(currentCatalog, paths);
      loadPhotos();
    } catch (e) { 
      console.error(e);
      loadPhotos();
    }
  }, [selectedPaths, currentCatalog, restorePhoto, clearSelection, loadPhotos]);

  const handleRemoveIdentificationSelected = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    try {
      const selectedPhotos = photos.filter(p => selectedPaths.has(getPhotoId(p)));
      const rowids: number[] = [];
      selectedPhotos.forEach(p => {
        (p.faces || []).forEach(f => {
          if (f.rowid) rowids.push(f.rowid);
        });
      });
      
      if (rowids.length > 0) {
        await api.bulkManualIdentify(currentCatalog, "Desconhecido", rowids);
        clearSelection();
        loadPhotos();
      }
    } catch (e) { console.error(e); }
  }, [selectedPaths, photos, currentCatalog, clearSelection, loadPhotos]);

  const handleDragStart = useCallback((photo: Photo) => {
    const id = getPhotoId(photo);
    if (!selectedPaths.has(id)) {
      // Forçar seleção se não estiver selecionada
      toggleSelection(photo, { ctrlKey: false, metaKey: false, shiftKey: false } as any);
    }
    setIsDraggingPhoto(true);
    setBulkBarVisible(true);
  }, [selectedPaths, toggleSelection]);

  const handleDragEnd = useCallback((_photo: Photo, e: React.PointerEvent) => {
    setIsDraggingPhoto(false);
    
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const actionBtn = target?.closest('[data-bulk-action]');
    
    if (actionBtn) {
      const action = actionBtn.getAttribute('data-bulk-action');
      if (action === 'discard') handleDiscardSelected();
      else if (action === 'restore') handleRestoreSelected();
      else if (action === 'remove-identification') handleRemoveIdentificationSelected();
    } else {
      // Se não soltou em uma ação, e não temos seleção (improvável aqui pois acabamos de selecionar ou já tinha), 
      // ou se o usuário quer que a barra suma se não houver drop (comportamento solicitado: "pode manter por 1s ou esconder")
      // Vamos manter a barra visível se houver seleção para permitir cliques manuais,
      // a menos que o usuário não queira. O prompt diz "pode manter por 1s ou esconder".
      // Se "esconder", o usuário teria que arrastar de novo para ver a barra.
      // Vamos deixar ela visível se houver seleção.
    }
  }, [handleDiscardSelected, handleRestoreSelected, handleRemoveIdentificationSelected]);

  // Reset bulk bar if selection is cleared
  useEffect(() => {
    if (selectedPaths.size === 0) {
      setBulkBarVisible(false);
    }
  }, [selectedPaths.size]);

  // Hide bulk bar when opening viewer
  useEffect(() => {
    if (viewerPhoto) {
      setBulkBarVisible(false);
    }
  }, [viewerPhoto]);

  // Save/restore scroll position when opening/closing viewer
  useEffect(() => {
    if (viewerPhoto) {
      savedScrollRef.current = gridScrollRef.current?.scrollTop ?? 0;
    } else if (savedScrollRef.current > 0) {
      const target = savedScrollRef.current;
      savedScrollRef.current = 0;
      requestAnimationFrame(() => {
        if (gridScrollRef.current) {
          gridScrollRef.current.scrollTop = target;
        }
      });
    }
  }, [!!viewerPhoto]);

  // ── Hotkeys do catálogo (grid) ──
  const lastFocusedIndexRef = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignorar quando viewer aberto (ele tem seu próprio handler)
      if (viewerPhoto) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

      // Espaço — abre a foto selecionada (ou a primeira) no viewer
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        if (selectedPaths.size > 0) {
          const first = filteredPhotos.find((p) => selectedPaths.has(getPhotoId(p)));
          if (first) { setViewerPhoto(first); return; }
        }
        if (filteredPhotos.length > 0) setViewerPhoto(filteredPhotos[0]);
        return;
      }

      // ← → — navegar entre fotos (seleciona a anterior/próxima)
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (filteredPhotos.length === 0) return;
        e.preventDefault();
        const currentIdx = lastFocusedIndexRef.current;
        const direction = e.key === "ArrowRight" ? 1 : -1;
        const nextIdx = Math.max(0, Math.min(filteredPhotos.length - 1, currentIdx + direction));
        lastFocusedIndexRef.current = nextIdx;
        const nextPhoto = filteredPhotos[nextIdx];
        if (nextPhoto) {
          // Se viewer fechado: apenas seleciona a foto
          toggleSelection(nextPhoto, { ctrlKey: false, metaKey: false, shiftKey: false } as any);
        }
        return;
      }

      // Enter — abre viewer na foto selecionada ou focada
      if (e.key === "Enter") {
        e.preventDefault();
        const idx = lastFocusedIndexRef.current;
        const photo = filteredPhotos[idx];
        if (photo) setViewerPhoto(photo);
        return;
      }

      // D — descartar fotos selecionadas
      if ((e.key === "d" || e.key === "D") && !e.ctrlKey && !e.metaKey) {
        if (selectedPaths.size === 0) return;
        e.preventDefault();
        handleDiscardSelected();
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [viewerPhoto, filteredPhotos, selectedPaths, setViewerPhoto, toggleSelection, handleDiscardSelected]);

  // Publica subfolders no contexto para a Sidebar mostrar a árvore
  useEffect(() => {
    if (!currentCatalog) {
      setCatalogSubfolders([]);
      return;
    }
    
    catalogApi.getAllSubfolders(currentCatalog).then(res => {
      if (res && res.ok && Array.isArray(res.subfolders)) {
        const photoPaths = photos.map(p => getPhotoPath(p));
        const allPaths = [...res.subfolders, ...photoPaths];
        const prefix = findCommonPrefix(allPaths);
        
        const relativeSubfolders = res.subfolders.map(folder => {
          const normFolder = normalizePath(folder);
          const normPrefix = normalizePath(prefix);
          
          if (normPrefix && normFolder.toLowerCase().startsWith(normPrefix.toLowerCase() + '/')) {
            return normFolder.slice(normPrefix.length + 1);
          } else if (normPrefix && normFolder.toLowerCase() === normPrefix.toLowerCase()) {
            return '';
          }
          return folder.split(/[\\/]/).filter(Boolean).pop() || '';
        }).filter(Boolean);
        
        const sortedUnique = Array.from(new Set(relativeSubfolders))
          .filter(s => s.length > 0)
          .sort((a, b) => a.localeCompare(b, 'pt-BR'));
          
        setCatalogSubfolders(sortedUnique);
      } else {
        const subfolders = extractSubfolders(photos);
        setCatalogSubfolders(subfolders);
      }
    }).catch(err => {
      console.error("[CatalogView] falha ao buscar subpastas:", err);
      const subfolders = extractSubfolders(photos);
      setCatalogSubfolders(subfolders);
    });
  }, [photos, setCatalogSubfolders, currentCatalog]);

  useEffect(() => {
    if (loading) {
      firstThumbLoadStartRef.current = perfNow();
      firstThumbLoggedRef.current = false;
    }
  }, [loading, currentCatalog]);

  const handleFirstThumbLoad = useCallback(() => {
    if (firstThumbLoggedRef.current || firstThumbLoadStartRef.current == null) return;
    firstThumbLoggedRef.current = true;
    logPerf('catalog first thumbnail', firstThumbLoadStartRef.current);
  }, []);

  const startQualityAudit = useCallback(async () => {
    if (!currentCatalog || auditStarting) return;
    setAuditStarting(true);
    setAuditStatus({
      ...QUALITY_AUDIT_IDLE_STATUS,
      status: 'running',
      running: true,
      is_auditing: true,
      status_text: 'Iniciando QA...',
      message: 'Iniciando QA...',
    });
    try {
      await api.startQualityAudit(currentCatalog);
    } catch (e) {
      console.error(e);
      setAuditStatus({
        ...QUALITY_AUDIT_IDLE_STATUS,
        status_text: 'Falha ao iniciar QA',
        message: 'Falha ao iniciar QA',
      });
    } finally {
      setAuditStarting(false);
    }
  }, [currentCatalog, auditStarting]);

  useEffect(() => {
    if (!currentCatalog) return;
    let disposed = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleNext = (delayMs: number) => {
      clearTimer();
      timer = window.setTimeout(() => {
        void fetchAuditStatus();
      }, delayMs);
    };

    const fetchAuditStatus = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const nextStatus = await api.getQualityAuditStatus({ signal: controller.signal });
        if (disposed) return;
        setAuditStatus(nextStatus);
        if (nextStatus.running || nextStatus.is_auditing) {
          scheduleNext(2000);
        }
      } catch (error) {
        if (disposed) return;
        const err = error as { name?: string; status?: number };
        if (err?.name === 'AbortError') return;
        if (err?.status === 404) {
          setAuditStatus({
            ...QUALITY_AUDIT_IDLE_STATUS,
            message: 'Auditoria pendente',
            status_text: 'Auditoria pendente',
          });
          return;
        }
        setAuditStatus((prev) => prev ?? QUALITY_AUDIT_IDLE_STATUS);
      }
    };

    void fetchAuditStatus();

    return () => {
      disposed = true;
      clearTimer();
      controller?.abort();
    };
  }, [currentCatalog, auditStatus?.is_auditing, auditStatus?.running]);

  const subtitle = loading && photos.length === 0
    ? 'Carregando fotos...'
    : `${filteredPhotos.length} foto${filteredPhotos.length !== 1 ? 's' : ''} encontrada${filteredPhotos.length !== 1 ? 's' : ''}` +
      (catalogSubfolder ? ` em "${catalogSubfolder}"` : '');

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h1>Evento</h1>
          <p className="view-subtitle">{subtitle}</p>
        </div>
        <div className="view-header-actions">
          <PhotoFilters filter={filter} onFilterChange={setFilter} hideDiscarded={hideDiscarded} onHideDiscardedChange={setHideDiscarded} />
          <ZoomControl zoom={zoom} onZoom={setZoom} min={0} max={100} step={5} />

          {/* Hotkeys popover */}
          <div style={{ position: 'relative' }}>
            <button
              className="icon-btn"
              title="Atalhos de teclado"
              onClick={() => setShowHotkeys(v => !v)}
              style={{ color: showHotkeys ? 'var(--accent, #7c5cbf)' : undefined }}
            >
              <Keyboard size={16} />
            </button>
            {showHotkeys && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 999,
                background: 'var(--surface-2, #1e1e2e)', border: '1px solid var(--border, rgba(255,255,255,0.1))',
                borderRadius: 10, padding: '14px 16px', minWidth: 240, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Atalhos de teclado</span>
                  <button
                    onClick={() => setShowHotkeys(false)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-muted)', lineHeight: 1 }}
                  ><X size={13} /></button>
                </div>

                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>No Catálogo</div>
                {HOTKEYS_GRID.map(h => (
                  <div key={h.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', gap: 12 }}>
                    <kbd style={{
                      background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                      borderRadius: 4, padding: '1px 7px', fontSize: '0.75rem', fontFamily: 'monospace',
                      color: 'var(--text-primary)', whiteSpace: 'nowrap', flexShrink: 0,
                    }}>{h.key}</kbd>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textAlign: 'right' }}>{h.desc}</span>
                  </div>
                ))}

                <div style={{ height: 1, background: 'var(--border, rgba(255,255,255,0.08))', margin: '10px 0' }} />
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>No Viewer</div>
                {HOTKEYS_VIEWER.map(h => (
                  <div key={h.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', gap: 12 }}>
                    <kbd style={{
                      background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                      borderRadius: 4, padding: '1px 7px', fontSize: '0.75rem', fontFamily: 'monospace',
                      color: 'var(--text-primary)', whiteSpace: 'nowrap', flexShrink: 0,
                    }}>{h.key}</kbd>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textAlign: 'right' }}>{h.desc}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button className="icon-btn" title="Atualizar" onClick={loadPhotos}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      <div className="catalog-audit-strip">
        <div className="catalog-audit-meta">
          <span className="catalog-audit-icon">
            <ShieldCheck size={14} />
          </span>
          <div className="catalog-audit-copy">
            <strong>Qualidade</strong>
            <span>
              {auditStatus?.running || auditStatus?.is_auditing
                ? `${auditStatus.status_text} (${Math.round(auditStatus.progress * 100)}%)`
                : 'Auditoria em segundo plano para foco, blur e consistência visual.'}
            </span>
          </div>
        </div>

        {auditStatus?.running || auditStatus?.is_auditing ? (
          <span className="catalog-audit-progress">
            {auditStarting ? 'Iniciando...' : 'Em análise'}
          </span>
        ) : (
          <button className="catalog-audit-btn" onClick={startQualityAudit} disabled={auditStarting}>
            Iniciar QA
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flex: 1, gap: '16px', overflow: 'hidden', minHeight: 0 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, position: 'relative' }}>
          {loading && photos.length === 0 ? (
            <div className="empty-state">
              <RefreshCw size={32} className="spin" />
              <p>Carregando fotos...</p>
            </div>
          ) : (
            <>
              <VirtualizedPhotoGrid
                photos={filteredPhotos}
                selectedPaths={selectedPaths}
                onPhotoClick={toggleSelection}
                onDoubleClick={setViewerPhoto}
                onOpenDetails={setDetailsPhoto}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onFirstThumbLoad={handleFirstThumbLoad}
                onLoadMore={loadMore}
                hasMore={hasMore}
                loadingMore={loadingMore}
                zoom={size}
                getSelectionCount={getSelectionCount}
                resetScrollKey={`${currentCatalog}|${catalogSubfolder ?? ''}|${filter}|${hideDiscarded ? '1' : '0'}`}
                scrollRef={gridScrollRef}
              />
            </>
          )}

        </div>

        {detailsPhoto && (
          <PhotoDetailPanel
            photo={detailsPhoto}
            onClose={() => setDetailsPhoto(null)}
          />
        )}
      </div>

      {viewerPhoto && (
        <PhotoViewerModal
          photo={viewerPhoto}
          allPhotos={filteredPhotos}
          onClose={() => setViewerPhoto(null)}
          onNavigate={setViewerPhoto}
          onDiscard={discardPhoto}
          onRestore={restorePhoto}
        />
      )}

      {selectedPaths.size > 0 && bulkBarVisible && !viewerPhoto && (
        <PhotoBulkActionsBar
          selectedCount={selectedPaths.size}
          onDiscard={handleDiscardSelected}
          onRestore={handleRestoreSelected}
          onRemoveIdentification={handleRemoveIdentificationSelected}
          onClearSelection={clearSelection}
        />
      )}
    </div>
  );
}
