import { useState, useEffect, useCallback, useMemo } from 'react';
import { Image as ImageIcon, RefreshCw, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { api, type Photo, type PhotoFace } from '../services/api';
import { useApp } from '../context/AppContext';

type PhotoFilter = 'all' | 'mapped' | 'unmapped';

function isKnownFace(face: PhotoFace): boolean {
  const id = String(face?.aluno_id ?? '').trim().toLowerCase();
  return Boolean(
    id &&
    id !== 'unknown' &&
    id !== 'desconhecido' &&
    id !== 'sem_nome' &&
    id !== 'nao_mapeado' &&
    id !== 'não_mapeado' &&
    id !== '__unknown__'
  );
}

function isPhotoMapped(photo: Photo): boolean {
  return Array.isArray(photo.faces) && photo.faces.some(isKnownFace);
}

function isPhotoUnmapped(photo: Photo): boolean {
  return !isPhotoMapped(photo);
}

function PhotoThumb({ photo }: { photo: Photo }) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  return (
    <div className="photo-img-placeholder">
      {!hasError && (
        <img
          src={api.thumbUrl(photo.path, 300)}
          alt={photo.name}
          loading="lazy"
          decoding="async"
          style={{ opacity: isLoaded ? 1 : 0 }}
          onLoad={() => {
            console.log('[thumb-load]', photo.name);
            setIsLoaded(true);
          }}
          onError={() => {
            console.log('[thumb-error]', photo.name);
            setHasError(true);
          }}
        />
      )}
      {!isLoaded && !hasError && <div className="photo-skeleton" />}
      {hasError && (
        <div className="photo-error-fallback">
          <ImageIcon size={24} opacity={0.4} />
          <span>Erro</span>
        </div>
      )}
      {(photo.blur_label === 'Possivelmente desfocada' || photo.blur_label === 'blurry') && (
        <div className="blur-badge blur-blurry">
          Desfocada
        </div>
      )}
      {(photo.blur_label === 'Atenção' || photo.blur_label === 'attention') && (
        <div className="blur-badge blur-attention">
          Verificar foco
        </div>
      )}
    </div>
  );
}

function extractSubfolders(photos: Photo[], catalogName: string): string[] {
  const folders = new Set<string>();
  for (const photo of photos) {
    const pathParts = photo.path.split(/[/\\]/);
    if (pathParts.length > 1) {
      const catalogIndex = pathParts.findIndex(p => p === catalogName);
      if (catalogIndex >= 0 && catalogIndex + 1 < pathParts.length - 1) {
        folders.add(pathParts[catalogIndex + 1]);
      }
    }
  }
  return Array.from(folders).sort();
}

export default function PhotosView() {
  const { currentCatalog, refreshKey } = useApp();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [filter, setFilter] = useState<PhotoFilter>('all');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Photo | null>(null);
  const [selectedSubfolder, setSelectedSubfolder] = useState<string | null>(null);
  const [viewerPhoto, setViewerPhoto] = useState<Photo | null>(null);

  const subfolders = useMemo(() => extractSubfolders(photos, currentCatalog), [photos, currentCatalog]);

  const loadPhotos = useCallback(async () => {
    if (!currentCatalog) return;
    setPhotos([]);
    setLoading(true);
    try {
      const arr = await api.getAllPhotos(currentCatalog);
      setPhotos(arr);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [currentCatalog, refreshKey]);

  useEffect(() => { Promise.resolve().then(loadPhotos); }, [loadPhotos]);

  const filtered = photos.filter(p => {
    if (selectedSubfolder) {
      const pathParts = p.path.split(/[/\\]/);
      const catalogIndex = pathParts.findIndex(part => part === currentCatalog);
      if (catalogIndex < 0 || pathParts[catalogIndex + 1] !== selectedSubfolder) return false;
    }
    if (filter === 'mapped') return isPhotoMapped(p);
    if (filter === 'unmapped') return isPhotoUnmapped(p);
    return true;
  });

  console.log('[PhotosView filter]', {
    total: photos.length,
    mapped: photos.filter(isPhotoMapped).length,
    unmapped: photos.filter(isPhotoUnmapped).length,
    sample: photos.slice(0, 5).map(p => ({ name: p.name, faces: p.faces })),
  });

  useEffect(() => {
    if (!viewerPhoto) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setViewerPhoto(null);
      } else if (e.key === 'ArrowLeft') {
        const idx = filtered.findIndex(p => p.path === viewerPhoto.path);
        if (idx > 0) setViewerPhoto(filtered[idx - 1]);
      } else if (e.key === 'ArrowRight') {
        const idx = filtered.findIndex(p => p.path === viewerPhoto.path);
        if (idx < filtered.length - 1) setViewerPhoto(filtered[idx + 1]);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [viewerPhoto, filtered]);

  const tabs: { key: PhotoFilter; label: string }[] = [
    { key: 'all', label: 'Todas' },
    { key: 'mapped', label: 'Identificadas' },
    { key: 'unmapped', label: 'Não Mapeadas' },
  ];

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h1>Catálogo do Evento</h1>
          <p className="view-subtitle">
            {loading && photos.length === 0 ? 'Carregando fotos...' : 
              `${filtered.length} foto${filtered.length !== 1 ? 's' : ''} encontrada${filtered.length !== 1 ? 's' : ''}` +
              (selectedSubfolder ? ` em "${selectedSubfolder}"` : '')
            }
          </p>
        </div>
        <div className="view-header-actions">
          {subfolders.length > 0 && (
            <div className="subfolder-filters">
              <button
                className={`subfolder-btn ${selectedSubfolder === null ? 'active' : ''}`}
                onClick={() => setSelectedSubfolder(null)}
              >
                Todas as pastas
              </button>
              {subfolders.map(folder => (
                <button
                  key={folder}
                  className={`subfolder-btn ${selectedSubfolder === folder ? 'active' : ''}`}
                  onClick={() => setSelectedSubfolder(folder)}
                >
                  {folder}
                </button>
              ))}
            </div>
          )}
          <div className="tab-group">
            {tabs.map(t => (
              <button
                key={t.key}
                className={`tab-btn ${filter === t.key ? 'active' : ''}`}
                onClick={() => setFilter(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button className="icon-btn" title="Atualizar" onClick={loadPhotos}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, gap: '16px', overflow: 'hidden', minHeight: 0 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
          {loading && photos.length === 0 ? (
            <div className="empty-state">
              <RefreshCw size={32} className="spin" />
              <p>Carregando fotos...</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">
              <ImageIcon size={48} opacity={0.3} />
              <h3>Nenhuma foto encontrada</h3>
              <p>Use "Escanear Pasta" na barra superior para adicionar fotos.</p>
            </div>
          ) : (
            <div className="photo-grid">
              {filtered.map((photo, i) => {
                const isMapped = isPhotoMapped(photo);
                const knownNames = (photo.faces ?? []).filter(isKnownFace).map(f => f.aluno_id).filter((v, idx, a) => a.indexOf(v) === idx);
                const firstName = knownNames.length > 0 ? knownNames.join(', ') : 'Não mapeada';
                return (
                  <div
                    key={photo.path || i}
                    className={`photo-card ${selected?.path === photo.path ? 'selected' : ''}`}
                    onClick={() => setSelected(selected?.path === photo.path ? null : photo)}
                    onDoubleClick={() => setViewerPhoto(photo)}
                  >
                    <PhotoThumb photo={photo} />
<div className="photo-info">
                      <div className="photo-name" title={photo.name}>{photo.name}</div>
                      <div className="photo-status">
                        <div className={`status-indicator ${isMapped ? 'mapped' : 'unmapped'}`} />
                        <span>{firstName}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {selected && (
          <div className="photo-detail-panel">
            <div className="photo-detail-header">
              <span>{selected.name}</span>
              <button className="icon-btn" onClick={() => setSelected(null)}>✕</button>
            </div>
            <img
              src={api.thumbUrl(selected.path, 600)}
              alt={selected.name}
              style={{ width: '100%', borderRadius: 8, marginBottom: 12, objectFit: 'contain' }}
            />
            <div className="detail-info">
              <div className="detail-row"><span>Tamanho</span><span>{selected.size ? `${(selected.size / 1024).toFixed(0)} KB` : '—'}</span></div>
              <div className="detail-row"><span>Qualidade</span><span>{selected.blur_label || '—'}</span></div>
              <div className="detail-row"><span>Faces</span><span>{selected.total_faces_in_db}</span></div>
              {selected.faces.filter(isKnownFace).length > 0 && (
                <div className="detail-row"><span>Pessoas</span><span>{selected.faces.filter(isKnownFace).map(f => f.aluno_id).join(', ')}</span></div>
              )}
            </div>
          </div>
        )}
      </div>

      {viewerPhoto && (
        <div className="photo-viewer-modal" onClick={() => setViewerPhoto(null)}>
          <div className="photo-viewer-content" onClick={e => e.stopPropagation()}>
            <button className="viewer-close" onClick={() => setViewerPhoto(null)}>
              <X size={24} />
            </button>
            <div className="viewer-image-wrap">
              {filtered.findIndex(p => p.path === viewerPhoto.path) > 0 && (
                <button className="viewer-nav viewer-prev" onClick={() => {
                  const idx = filtered.findIndex(p => p.path === viewerPhoto.path);
                  setViewerPhoto(filtered[idx - 1]);
                }}>
                  <ChevronLeft size={32} />
                </button>
              )}
              <img src={api.thumbUrl(viewerPhoto.path, 1200)} alt={viewerPhoto.name} />
              {filtered.findIndex(p => p.path === viewerPhoto.path) < filtered.length - 1 && (
                <button className="viewer-nav viewer-next" onClick={() => {
                  const idx = filtered.findIndex(p => p.path === viewerPhoto.path);
                  setViewerPhoto(filtered[idx + 1]);
                }}>
                  <ChevronRight size={32} />
                </button>
              )}
            </div>
            <div className="viewer-footer">
              <span className="viewer-name">{viewerPhoto.name}</span>
              <span className="viewer-counter">{filtered.findIndex(p => p.path === viewerPhoto.path) + 1} / {filtered.length}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
