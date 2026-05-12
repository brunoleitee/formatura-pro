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
import PhotoBulkActionsBar from '../components/photos/PhotoBulkActionsBar';
import { extractSubfolders } from '../utils/pathUtils';

export default function CatalogView() {
  const { currentCatalog, catalogSubfolder, setCatalogSubfolders, setIsLoadingCatalogPhotos } = useApp();
  const { photos, loading, loadPhotos } = useCatalogPhotos();
  const { filter, setFilter, filteredPhotos } = usePhotoFilters(photos, currentCatalog, catalogSubfolder);
  const { selectedPaths, toggleSelection, clearSelection } = usePhotoSelection(filteredPhotos);
  const { viewerPhoto, setViewerPhoto } = usePhotoViewer(filteredPhotos);

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
    try {
      await api.bulkDiscardPhotos(currentCatalog, Array.from(selectedPaths));
      clearSelection();
      loadPhotos();
    } catch (e) { console.error(e); }
  };

  const handleRestoreSelected = async () => {
    if (selectedPaths.size === 0) return;
    try {
      await api.bulkRestorePhotos(currentCatalog, Array.from(selectedPaths));
      clearSelection();
      loadPhotos();
    } catch (e) { console.error(e); }
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
          <PhotoFilters filter={filter} onFilterChange={setFilter} />
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
        />
      )}

      {selectedPaths.size > 0 && (
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
