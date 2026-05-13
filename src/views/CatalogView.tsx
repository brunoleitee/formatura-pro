import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { api, type Photo, type QualityAuditStatus } from '../services/api';
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

export default function CatalogView() {
  const { currentCatalog, catalogSubfolder, setCatalogSubfolders, setIsLoadingCatalogPhotos } = useApp();
  const { photos, loading, loadPhotos, discardPhoto, restorePhoto } = useCatalogPhotos();
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
  const firstThumbLoadStartRef = useRef<number | null>(null);
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

  // Sincronizar loading com contexto
  useEffect(() => {
    setIsLoadingCatalogPhotos(loading);
  }, [loading, setIsLoadingCatalogPhotos]);

  // Publica subfolders no contexto para a Sidebar mostrar a árvore
  useEffect(() => {
    const subfolders = extractSubfolders(photos);
    setCatalogSubfolders(subfolders);
  }, [photos, setCatalogSubfolders]);

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
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
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
                zoom={size}
                getSelectionCount={getSelectionCount}
                resetScrollKey={`${currentCatalog}|${catalogSubfolder ?? ''}|${filter}|${hideDiscarded ? '1' : '0'}`}
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
