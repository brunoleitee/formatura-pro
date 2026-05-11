import { RefreshCw } from 'lucide-react';
import { api } from '../services/api';
import { useApp } from '../context/AppContext';
import { useCatalogPhotos } from '../hooks/useCatalogPhotos';
import { usePhotoFilters } from '../hooks/usePhotoFilters';
import { usePhotoSelection } from '../hooks/usePhotoSelection';
import { usePhotoViewer } from '../hooks/usePhotoViewer';
import { PhotoGrid } from '../components/photos/PhotoGrid';
import { PhotoDetailPanel } from '../components/photos/PhotoDetailPanel';
import { PhotoViewerModal } from '../components/photos/PhotoViewerModal';
import { PhotoFilters } from '../components/photos/PhotoFilters';
import { FolderTree } from '../components/photos/FolderTree';
import { useState, useEffect, useCallback } from 'react';

export default function CatalogView() {
  const { currentCatalog } = useApp();
  const { photos, loading, loadPhotos } = useCatalogPhotos();
  const { filter, setFilter, selectedSubfolder, setSelectedSubfolder, subfolders, filteredPhotos } = usePhotoFilters(photos, currentCatalog);
  const { selectedPhoto, setSelectedPhoto, handlePhotoClick } = usePhotoSelection();
  const { viewerPhoto, setViewerPhoto } = usePhotoViewer(filteredPhotos);

  useEffect(() => {
    console.log('[catalog-debug]', {
      rawTotal: photos.length,
      filteredTotal: filteredPhotos.length,
      filter,
      samples: photos.slice(0, 10).map(p => ({
        name: p.name,
        path: p.path,
        faces: p.faces,
        type: p.type
      }))
    });
  }, [photos, filteredPhotos, filter]);

  const [auditStatus, setAuditStatus] = useState<{ is_auditing: boolean; status_text: string; progress: number } | null>(null);

  const startQualityAudit = useCallback(async () => {
    try {
      await api.startQualityAudit(currentCatalog);
      setAuditStatus({ is_auditing: true, status_text: 'Iniciando...', progress: 0 });
    } catch (e) { console.error(e); }
  }, [currentCatalog]);

  useEffect(() => {
    if (!currentCatalog) return;
    const checkAudit = async () => {
      try {
        const st = await api.getQualityAuditStatus();
        setAuditStatus(st);
      } catch {}
    };
    checkAudit();
    const interval = setInterval(checkAudit, 2000);
    return () => clearInterval(interval);
  }, [currentCatalog]);

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h1>Evento</h1>
          <p className="view-subtitle">
            {loading && photos.length === 0 ? 'Carregando fotos...' : 
              `${filteredPhotos.length} foto${filteredPhotos.length !== 1 ? 's' : ''} encontrada${filteredPhotos.length !== 1 ? 's' : ''}` +
              (selectedSubfolder ? ` em "${selectedSubfolder}"` : '')
            }
          </p>
        </div>
        <div className="view-header-actions">
          <FolderTree subfolders={subfolders} selectedSubfolder={selectedSubfolder} onSelectSubfolder={setSelectedSubfolder} />
          <PhotoFilters filter={filter} onFilterChange={setFilter} />
          <button className="icon-btn" title="Atualizar" onClick={loadPhotos}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
          {auditStatus?.is_auditing ? (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginLeft: 8 }}>
              {auditStatus.status_text} ({Math.round(auditStatus.progress * 100)}%)
            </span>
          ) : (
            <button className="icon-btn" title="Auditar qualidade das fotos" onClick={startQualityAudit} style={{ marginLeft: 4 }}>
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
            <PhotoGrid
              photos={filteredPhotos}
              selectedPhoto={selectedPhoto}
              onPhotoClick={(photo) => handlePhotoClick(photo, setViewerPhoto)}
            />
          )}
        </div>

        {selectedPhoto && (
          <PhotoDetailPanel
            photo={selectedPhoto}
            onClose={() => setSelectedPhoto(null)}
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
    </div>
  );
}
