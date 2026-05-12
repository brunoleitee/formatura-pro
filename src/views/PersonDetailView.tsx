import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, RefreshCw, Image as ImageIcon } from 'lucide-react';
import { api, type Photo } from '../services/api';
import { useApp } from '../context/AppContext';
import { PhotoCard } from '../components/photos/PhotoCard';
import { PhotoDetailPanel } from '../components/photos/PhotoDetailPanel';
import { PhotoViewerModal } from '../components/photos/PhotoViewerModal';
import { usePhotoSelection, getPhotoId } from '../hooks/usePhotoSelection';
import { usePhotoViewer } from '../hooks/usePhotoViewer';
import PhotoBulkActionsBar from '../components/photos/PhotoBulkActionsBar';

function Section({ 
  title, 
  items, 
  color, 
  selectedPaths, 
  onPhotoClick, 
  onDoubleClick, 
  onOpenDetails,
  onLongPress
}: { 
  title: string; 
  items: Photo[]; 
  color: string;
  selectedPaths: Set<string>;
  onPhotoClick: (photo: Photo, event: React.MouseEvent) => void;
  onDoubleClick: (photo: Photo) => void;
  onOpenDetails: (photo: Photo) => void;
  onLongPress: (photo: Photo) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 32 }}>
      <h3 style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
        {title}
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 400 }}>({items.length})</span>
      </h3>
      <div className="photo-grid">
        {items.map((p) => {
          const id = getPhotoId(p);
          return (
            <PhotoCard 
              key={id} 
              photo={p} 
              isSelected={selectedPaths.has(id)} 
              onClick={onPhotoClick}
              onDoubleClick={onDoubleClick}
              onOpenDetails={onOpenDetails}
              onLongPress={onLongPress}
            />
          );
        })}
      </div>
    </div>
  );
}

export default function PersonDetailView() {
  const { selectedPersonId, navigate, currentCatalog } = useApp();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailsPhoto, setDetailsPhoto] = useState<Photo | null>(null);

  const { selectedPaths, toggleSelection, clearSelection } = usePhotoSelection(photos);
  const { viewerPhoto, setViewerPhoto } = usePhotoViewer(photos);
  const [bulkBarVisible, setBulkBarVisible] = useState(false);

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

  const load = useCallback(async () => {
    if (!selectedPersonId || !currentCatalog) return;
    setLoading(true);
    try {
      const data = await api.getPersonPhotos(selectedPersonId);
      setPhotos(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [selectedPersonId, currentCatalog]);

  useEffect(() => { load(); }, [load]);

  const updatePhotoStatusLocal = useCallback((path: string, updates: Partial<Photo>) => {
    setPhotos(prev => prev.map(p => 
      p.path === path ? { ...p, ...updates } : p
    ));
  }, []);

  const handleDiscardSelected = async () => {
    if (selectedPaths.size === 0) return;
    const paths = photos.filter(p => selectedPaths.has(getPhotoId(p))).map(p => p.path);
    paths.forEach(p => updatePhotoStatusLocal(p, { discarded: true }));
    clearSelection();
    try {
      await api.bulkDiscardPhotos(currentCatalog, paths);
      load();
    } catch (e) { 
      console.error(e);
      load();
    }
  };

  const handleRestoreSelected = async () => {
    if (selectedPaths.size === 0) return;
    const paths = photos.filter(p => selectedPaths.has(getPhotoId(p))).map(p => p.path);
    paths.forEach(p => updatePhotoStatusLocal(p, { discarded: false }));
    clearSelection();
    try {
      await api.bulkRestorePhotos(currentCatalog, paths);
      load();
    } catch (e) { 
      console.error(e);
      load();
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
        load();
      }
    } catch (e) { console.error(e); }
  };

  if (!selectedPersonId) return null;

  const good = photos.filter(p => !p.discarded && p.blur_label !== 'blurry');
  const attention = photos.filter(p => !p.discarded && p.blur_label === 'attention');
  const blurry = photos.filter(p => !p.discarded && p.blur_label === 'blurry');
  const discarded = photos.filter(p => p.discarded);

  return (
    <div className="view-container" style={{ position: 'relative' }}>
      <div className="view-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="icon-btn" onClick={() => navigate('people')}>
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1>{selectedPersonId}</h1>
            <p className="view-subtitle">
              {photos.length} foto{photos.length !== 1 ? 's' : ''} no total
            </p>
          </div>
        </div>
        <div className="view-header-actions">
          <button className="icon-btn" onClick={load}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {loading && photos.length === 0 ? (
        <div className="empty-state">
          <RefreshCw size={32} className="spin" />
          <p>Carregando fotos...</p>
        </div>
      ) : photos.length === 0 ? (
        <div className="empty-state">
          <ImageIcon size={48} opacity={0.3} />
          <h3>Nenhuma foto encontrada</h3>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 24, flex: 1, overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto', paddingRight: 8 }}>
            <Section 
              title="Boas fotos" 
              items={good.filter(p => p.blur_label !== 'attention')} 
              color="var(--success-color)" 
              selectedPaths={selectedPaths}
              onPhotoClick={toggleSelection}
              onDoubleClick={setViewerPhoto}
              onOpenDetails={setDetailsPhoto}
              onLongPress={() => setBulkBarVisible(true)}
            />
            <Section 
              title="Requer atenção" 
              items={attention} 
              color="var(--warning-color)" 
              selectedPaths={selectedPaths}
              onPhotoClick={toggleSelection}
              onDoubleClick={setViewerPhoto}
              onOpenDetails={setDetailsPhoto}
              onLongPress={() => setBulkBarVisible(true)}
            />
            <Section 
              title="Desfocadas" 
              items={blurry} 
              color="var(--danger-color)" 
              selectedPaths={selectedPaths}
              onPhotoClick={toggleSelection}
              onDoubleClick={setViewerPhoto}
              onOpenDetails={setDetailsPhoto}
              onLongPress={() => setBulkBarVisible(true)}
            />
            <Section 
              title="Descartadas" 
              items={discarded} 
              color="var(--text-secondary)" 
              selectedPaths={selectedPaths}
              onPhotoClick={toggleSelection}
              onDoubleClick={setViewerPhoto}
              onOpenDetails={setDetailsPhoto}
              onLongPress={() => setBulkBarVisible(true)}
            />
          </div>

          {detailsPhoto && (
            <PhotoDetailPanel
              photo={detailsPhoto}
              onClose={() => setDetailsPhoto(null)}
            />
          )}
        </div>
      )}

      {viewerPhoto && (
        <PhotoViewerModal
          photo={viewerPhoto}
          allPhotos={photos}
          onClose={() => setViewerPhoto(null)}
          onNavigate={setViewerPhoto}
          onDiscard={(path) => updatePhotoStatusLocal(path, { discarded: true })}
          onRestore={(path) => updatePhotoStatusLocal(path, { discarded: false })}
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
