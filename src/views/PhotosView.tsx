import { useState, useEffect, useCallback } from 'react';
import { Image as ImageIcon, RefreshCw } from 'lucide-react';
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
      {photo.blur_label && photo.blur_label !== 'ok' && (
        <div className={`blur-badge blur-${photo.blur_label}`}>
          {photo.blur_label === 'blurry' ? 'Desfocada' : 'Atenção'}
        </div>
      )}
    </div>
  );
}

export default function PhotosView() {
  const { currentCatalog, refreshKey } = useApp();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [filter, setFilter] = useState<PhotoFilter>('all');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Photo | null>(null);

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
          <p className="view-subtitle">{filtered.length} foto{filtered.length !== 1 ? 's' : ''} encontrada{filtered.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="view-header-actions">
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
    </div>
  );
}
