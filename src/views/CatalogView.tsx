import { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type Photo } from '../services/api';
import { useApp } from '../context/AppContext';
import { useCatalogPhotos } from '../hooks/useCatalogPhotos';
import { usePhotoFilters } from '../hooks/usePhotoFilters';
import { usePhotoSelection, getPhotoId } from '../hooks/usePhotoSelection';
import { usePhotoViewer } from '../hooks/usePhotoViewer';
import { PhotoGrid } from '../components/photos/PhotoGrid';
import { PhotoDetailPanel } from '../components/photos/PhotoDetailPanel';
import { PhotoViewerModal } from '../components/photos/PhotoViewerModal';
import { PhotoFilters } from '../components/photos/PhotoFilters';
import { ZoomControl } from '../components/photos/ZoomControl';
import PhotoBulkActionsBar from '../components/photos/PhotoBulkActionsBar';
import { extractSubfolders } from '../utils/pathUtils';

const ZOOM_MIN = 100;
const ZOOM_MAX = 300;

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
  const [isDraggingPhoto, setIsDraggingPhoto] = useState(false);

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

  const [auditStatus, setAuditStatus] = useState<{
    is_auditing: boolean; status_text: string; progress: number;
  } | null>(null);

  const [detailsPhoto, setDetailsPhoto] = useState<Photo | null>(null);

  // Publica subfolders no contexto para a Sidebar mostrar a árvore
  useEffect(() => {
    const subfolders = extractSubfolders(photos);
    setCatalogSubfolders(subfolders);
  }, [photos, setCatalogSubfolders]);

  const startQualityAudit = useCallback(async () => {
    try {
      await api.startQualityAudit(currentCatalog);
      setAuditStatus({ is_auditing: true, status_text: 'Iniciando...', progress: 0 });
    } catch (e) { console.error(e); }
  }, [currentCatalog]);

  useEffect(() => {
    if (!currentCatalog) return;
    const checkAudit = async () => {
      try { setAuditStatus(await api.getQualityAuditStatus()); } catch {}
    };
    checkAudit();
    const id = setInterval(checkAudit, 2000);
    return () => clearInterval(id);
  }, [currentCatalog]);

  const handleDiscardSelected = async () => {
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
  };

  const handleRestoreSelected = async () => {
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
  };

  const handleRemoveIdentificationSelected = async () => {
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
  };

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
          {auditStatus?.is_auditing ? (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginLeft: 8 }}>
              {auditStatus.status_text} ({Math.round(auditStatus.progress * 100)}%)
            </span>
          ) : (
            <button className="icon-btn" title="Auditar qualidade" onClick={startQualityAudit} style={{ marginLeft: 4 }}>
              <span style={{ fontSize: '0.7rem' }}>QA</span>
            </button>
          )}
        </div>
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
              <PhotoGrid
                photos={filteredPhotos}
                selectedPaths={selectedPaths}
                onPhotoClick={toggleSelection}
                onDoubleClick={setViewerPhoto}
                onOpenDetails={setDetailsPhoto}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                zoom={size}
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
        />
      )}
    </div>
  );
}
