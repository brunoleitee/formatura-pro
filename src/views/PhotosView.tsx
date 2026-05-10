import { useState, useEffect, useCallback } from 'react';
import { Image as ImageIcon, MoreVertical, RefreshCw } from 'lucide-react';
import { api, type Photo } from '../services/api';
import { useApp } from '../context/AppContext';

type PhotoFilter = 'all' | 'mapped' | 'unmapped';

export default function PhotosView() {
  const { currentCatalog } = useApp();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [filter, setFilter] = useState<PhotoFilter>('all');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Photo | null>(null);

  const loadPhotos = useCallback(async () => {
    if (!currentCatalog) return;
    setLoading(true);
    try {
      const arr = await api.getAllPhotos();
      setPhotos(arr);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [currentCatalog]);

  useEffect(() => { Promise.resolve().then(loadPhotos); }, [loadPhotos]);

  const filtered = photos.filter(p => {
    if (filter === 'mapped') return p.faces && p.faces.length > 0;
    if (filter === 'unmapped') return !p.faces || p.faces.length === 0;
    return true;
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
          <h1>Fotos</h1>
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
            const isMapped = photo.faces && photo.faces.length > 0;
            const firstName = isMapped
              ? photo.faces.map(f => f.aluno_id).filter((v, idx, a) => a.indexOf(v) === idx).join(', ')
              : 'Não identificada';
            return (
              <div
                key={photo.path || i}
                className={`photo-card ${selected?.path === photo.path ? 'selected' : ''}`}
                onClick={() => setSelected(selected?.path === photo.path ? null : photo)}
              >
                <div className="photo-img-placeholder">
                  <img
                    src={api.thumbUrl(photo.path, 300)}
                    alt={photo.name}
                    loading="lazy"
                    onError={e => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  {photo.blur_label && photo.blur_label !== 'ok' && (
                    <div className={`blur-badge blur-${photo.blur_label}`}>
                      {photo.blur_label === 'blurry' ? 'Desfocada' : 'Atenção'}
                    </div>
                  )}
                </div>
                <div className="photo-info">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ overflow: 'hidden', flex: 1 }}>
                      <div className="photo-name" title={photo.name}>{photo.name}</div>
                      <div className="photo-status">
                        <div className={`status-indicator ${isMapped ? 'mapped' : 'unmapped'}`} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {firstName}
                        </span>
                      </div>
                    </div>
                    <button className="icon-btn" style={{ flexShrink: 0 }}>
                      <MoreVertical size={14} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selected && (
        <div className="photo-detail-panel">
          <div className="photo-detail-header">
            <span>{selected.name}</span>
            <button className="icon-btn" onClick={() => setSelected(null)}>✕</button>
          </div>
          <img
            src={api.thumbUrl(selected.path, 600)}
            alt={selected.name}
            style={{ width: '100%', borderRadius: 8, marginBottom: 12 }}
          />
          <div className="detail-info">
            <div className="detail-row"><span>Tamanho</span><span>{selected.size ? `${(selected.size / 1024).toFixed(0)} KB` : '—'}</span></div>
            <div className="detail-row"><span>Qualidade</span><span>{selected.blur_label || '—'}</span></div>
            <div className="detail-row"><span>Faces</span><span>{selected.total_faces_in_db}</span></div>
            {selected.faces.length > 0 && (
              <div className="detail-row"><span>Pessoas</span><span>{selected.faces.map(f => f.aluno_id).join(', ')}</span></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
