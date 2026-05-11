import { useState, useEffect, useCallback } from 'react';
import { UserCheck, RefreshCw, Check, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, type UnknownCluster, type ClusterFace } from '../services/api';
import { useApp } from '../context/AppContext';

export default function ReviewView() {
  const { currentCatalog } = useApp();
  const [clusters, setClusters] = useState<UnknownCluster[]>([]);
  const [loading, setLoading] = useState(false);
  const [clusterIdx, setClusterIdx] = useState(0);
  const [nameInput, setNameInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!currentCatalog) return;
    setLoading(true);
    try {
      const data = await api.getUnknownClusters(currentCatalog);
      setClusters(Array.isArray(data) ? data : []);
      setClusterIdx(0);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [currentCatalog]);

  useEffect(() => { Promise.resolve().then(load); }, [load]);

  const loadSuggestions = useCallback(async (q: string) => {
    if (q.length < 2) { setSuggestions([]); return; }
    try {
      const res = await api.globalSearch(q);
      setSuggestions(res.map(r => r.name).filter((v, i, a) => a.indexOf(v) === i).slice(0, 8));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { Promise.resolve().then(() => loadSuggestions(nameInput)); }, [nameInput, loadSuggestions]);

  const cluster = clusters[clusterIdx] ?? null;

  const handleIdentify = async () => {
    if (!cluster || !nameInput.trim()) return;
    setSaving(true);
    setMsg('');
    let success = 0;
    for (const face of cluster.faces) {
      try {
        await api.manualIdentify(face.foto_path, currentCatalog, [face.x1, face.y1, face.x2, face.y2], nameInput.trim());
        success++;
      } catch { /* continue */ }
    }
    setMsg(`${success}/${cluster.faces.length} face(s) identificada(s) como "${nameInput.trim()}"`);
    setSaving(false);
    setNameInput('');
    // Remove cluster from list
    const newClusters = clusters.filter((_, i) => i !== clusterIdx);
    setClusters(newClusters);
    setClusterIdx(Math.min(clusterIdx, newClusters.length - 1));
  };

  const handleSkip = () => {
    if (clusterIdx < clusters.length - 1) setClusterIdx(i => i + 1);
  };

  if (!currentCatalog) {
    return (
      <div className="view-container">
        <div className="empty-state">
          <p>Selecione um evento para revisar.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h1>Revisão IA</h1>
          <p className="view-subtitle">{clusters.length} grupo{clusters.length !== 1 ? 's' : ''} pendente{clusters.length !== 1 ? 's' : ''}</p>
        </div>
        <button className="icon-btn" onClick={load}>
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
        </button>
      </div>

      {loading && clusters.length === 0 ? (
        <div className="empty-state">
          <RefreshCw size={32} className="spin" />
          <p>Carregando grupos...</p>
        </div>
      ) : clusters.length === 0 ? (
        <div className="empty-state">
          <UserCheck size={48} opacity={0.3} />
          <h3>Tudo identificado!</h3>
          <p>Não há faces desconhecidas pendentes de revisão.</p>
        </div>
      ) : (
        <div className="review-layout">
          <div className="review-main">
            {msg && <div className="review-msg">{msg}</div>}

            {cluster && (
              <>
                <div className="review-cluster-header">
                  <button
                    className="icon-btn"
                    disabled={clusterIdx === 0}
                    onClick={() => setClusterIdx(i => i - 1)}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <span>Grupo {clusterIdx + 1} de {clusters.length} — {cluster.faces.length} foto{cluster.faces.length !== 1 ? 's' : ''}</span>
                  <button
                    className="icon-btn"
                    disabled={clusterIdx >= clusters.length - 1}
                    onClick={() => setClusterIdx(i => i + 1)}
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>

                <div className="review-faces-grid">
                  {cluster.faces.map((face: ClusterFace, i: number) => (
                    <div key={i} className="review-face-card">
                      <img
                        src={api.faceThumbUrl(face.foto_path, face.x1, face.y1, face.x2, face.y2, 160)}
                        alt={`face-${i}`}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    </div>
                  ))}
                </div>

                <div className="review-identify">
                  <div style={{ position: 'relative' }}>
                    <input
                      className="review-name-input"
                      placeholder="Nome do formando..."
                      value={nameInput}
                      onChange={e => setNameInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleIdentify()}
                    />
                    {suggestions.length > 0 && nameInput.length >= 2 && (
                      <div className="suggestions-dropdown">
                        {suggestions.map(s => (
                          <button
                            key={s}
                            className="suggestion-item"
                            onClick={() => { setNameInput(s); setSuggestions([]); }}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="review-actions">
                    <button
                      className="btn-primary"
                      onClick={handleIdentify}
                      disabled={saving || !nameInput.trim()}
                    >
                      <Check size={16} />
                      {saving ? 'Salvando...' : 'Identificar'}
                    </button>
                    <button className="btn-secondary" onClick={handleSkip}>
                      <X size={16} />
                      Pular
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="review-sidebar">
            <h3>Grupos Pendentes</h3>
            <div className="review-cluster-list">
              {clusters.map((c, i) => (
                <button
                  key={i}
                  className={`review-cluster-btn ${i === clusterIdx ? 'active' : ''}`}
                  onClick={() => setClusterIdx(i)}
                >
                  <div className="cluster-preview">
                    {c.faces.slice(0, 3).map((f, fi) => (
                      <img
                        key={fi}
                        src={api.faceThumbUrl(f.foto_path, f.x1, f.y1, f.x2, f.y2, 40)}
                        alt=""
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ))}
                  </div>
                  <span>{c.faces.length} foto{c.faces.length !== 1 ? 's' : ''}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
