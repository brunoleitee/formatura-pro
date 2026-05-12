import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, RefreshCw, Image as ImageIcon, FolderOpen } from 'lucide-react';
import { api, type Photo } from '../services/api';
import { useApp } from '../context/AppContext';

function PhotoCard({ photo, selected, onSelect }: { photo: Photo, selected: Photo | null, onSelect: (photo: Photo) => void }) {
  return (
    <div
      className={`photo-card ${selected?.path === photo.path ? 'selected' : ''} ${photo.discarded ? 'discarded' : ''}`}
      onClick={() => onSelect(photo)}
    >
      <div className="photo-img-placeholder">
        <img
          src={api.thumbUrl(photo.path, 300)}
          alt={photo.name}
          loading="lazy"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        {photo.blur_label && photo.blur_label !== 'ok' && (
          <div className={`blur-badge blur-${photo.blur_label}`}>
            {photo.blur_label === 'blurry' ? 'Desfocada' : 'Atenção'}
          </div>
        )}
        {photo.closed_eyes && (
          <div className="blur-badge blur-attention" style={{ bottom: 28 }}>Olhos fechados</div>
        )}
        {photo.discarded && (
          <div className="discardBadge">DESCARTADA</div>
        )}
      </div>
      <div className="photo-info">
        <div className="photo-name" title={photo.name}>{photo.name}</div>
      </div>
    </div>
  );
}

function Section({ title, items, color, selected, onSelect }: { title: string; items: Photo[]; color: string, selected: Photo | null, onSelect: (photo: Photo) => void }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 32 }}>
      <h3 style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
        {title}
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 400 }}>({items.length})</span>
      </h3>
      <div className="photo-grid">
        {items.map((p, i) => <PhotoCard key={p.path || i} photo={p} selected={selected} onSelect={onSelect} />)}
      </div>
    </div>
  );
}

export default function PersonDetailView() {
  const { selectedPersonId, navigate, currentCatalog } = useApp();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Photo | null>(null);

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
          {selected && (
            <button
              className="btn-secondary"
              onClick={() => api.openFolder(selected.path.substring(0, selected.path.lastIndexOf('\\') || selected.path.lastIndexOf('/')))}
            >
              <FolderOpen size={16} />
              Abrir Pasta
            </button>
          )}
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
        <div style={{ display: 'flex', gap: 24, height: '100%' }}>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <Section title="Boas fotos" items={good.filter(p => p.blur_label !== 'attention')} color="var(--success-color)" selected={selected} onSelect={(p) => setSelected(selected?.path === p.path ? null : p)} />
            <Section title="Requer atenção" items={attention} color="var(--warning-color)" selected={selected} onSelect={(p) => setSelected(selected?.path === p.path ? null : p)} />
            <Section title="Desfocadas" items={blurry} color="var(--danger-color)" selected={selected} onSelect={(p) => setSelected(selected?.path === p.path ? null : p)} />
            <Section title="Descartadas" items={discarded} color="var(--text-secondary)" selected={selected} onSelect={(p) => setSelected(selected?.path === p.path ? null : p)} />
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
                style={{ width: '100%', borderRadius: 8, marginBottom: 12 }}
              />
              <div className="detail-info">
                <div className="detail-row"><span>Qualidade</span><span>{selected.blur_label || 'ok'}</span></div>
                <div className="detail-row"><span>Faces</span><span>{selected.total_faces_in_db}</span></div>
                {selected.size && (
                  <div className="detail-row"><span>Tamanho</span><span>{(selected.size / 1024).toFixed(0)} KB</span></div>
                )}
                {selected.closed_eyes && (
                  <div className="detail-row"><span>Olhos</span><span style={{ color: 'var(--warning-color)' }}>Fechados</span></div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
