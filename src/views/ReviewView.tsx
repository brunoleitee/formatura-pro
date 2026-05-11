import { useState, useEffect, useCallback, memo } from 'react';
import { UserCheck, RefreshCw, ArrowLeft, Check, X, Users, Image as ImageIcon } from 'lucide-react';
import { api } from '../services/api';
import type { RichCluster, RichClusterFace } from '../services/api';
import { useApp } from '../context/AppContext';
import styles from './ReviewView.module.css';

const API_BASE = 'http://127.0.0.1:8000/api';

function faceThumbUrl(path: string, box: [number, number, number, number], size = 200) {
  return `${API_BASE}/thumb?path=${encodeURIComponent(path)}&x1=${box[0]}&y1=${box[1]}&x2=${box[2]}&y2=${box[3]}&size=${size}&expand=0.35`;
}

// ── Card de cluster (memorizado para performance) ──
const ClusterCard = memo(function ClusterCard({
  cluster,
  onClick,
}: {
  cluster: RichCluster;
  onClick: (c: RichCluster) => void;
}) {
  const rep = cluster.representative;
  const pct = Math.round(cluster.cohesion_score * 100);

  return (
    <button className={styles.clusterCard} onClick={() => onClick(cluster)}>
      <div className={styles.clusterThumb}>
        {rep ? (
          <img
            src={faceThumbUrl(rep.path, rep.box, 300)}
            alt="Rosto representante"
            loading="lazy"
            onError={e => {
              const t = e.currentTarget;
              t.style.display = 'none';
              const ph = t.nextElementSibling as HTMLElement | null;
              if (ph) ph.style.display = 'flex';
            }}
          />
        ) : null}
        <div className={styles.clusterThumbPlaceholder} style={{ display: rep ? 'none' : 'flex' }}>
          <ImageIcon size={36} />
        </div>
        <span className={styles.badgeUnknown}>Desconhecido</span>
      </div>
      <div className={styles.clusterInfo}>
        <span className={styles.clusterTitle}>Pessoa desconhecida</span>
        <div className={styles.clusterMeta}>
          <span className={styles.clusterCount}>
            <Users size={12} />
            {cluster.face_count} foto{cluster.face_count !== 1 ? 's' : ''} agrupadas
          </span>
          <span className={styles.confidencePill}>{pct}%</span>
        </div>
      </div>
    </button>
  );
});

// ── Face individual no grid do detail ──
const FaceThumb = memo(function FaceThumb({ face }: { face: RichClusterFace }) {
  return (
    <div className={styles.faceCard}>
      <img
        src={faceThumbUrl(face.path, face.box, 160)}
        alt="face"
        loading="lazy"
        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
      />
    </div>
  );
});

// ── View de detalhe de um cluster ──
function ClusterDetailView({
  cluster,
  catalog,
  onBack,
  onAssigned,
}: {
  cluster: RichCluster;
  catalog: string;
  onBack: () => void;
  onAssigned: (clusterId: string) => void;
}) {
  const [nameInput, setNameInput] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const loadSuggestions = useCallback(async (q: string) => {
    if (q.length < 2) { setSuggestions([]); return; }
    try {
      const res = await api.globalSearch(q);
      setSuggestions(res.map((r: { name: string }) => r.name).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).slice(0, 8));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => loadSuggestions(nameInput), 180);
    return () => clearTimeout(t);
  }, [nameInput, loadSuggestions]);

  const handleAssign = async () => {
    const name = nameInput.trim();
    if (!name || saving) return;
    setSaving(true);
    setMsg('');
    try {
      const rowids = cluster.faces.map(f => f.rowid);
      await api.assignCluster(catalog, cluster.cluster_id, name, rowids);
      setMsg(`${cluster.face_count} foto(s) identificada(s) como "${name}"`);
      setNameInput('');
      setSuggestions([]);
      setTimeout(() => onAssigned(cluster.cluster_id), 1200);
    } catch {
      setMsg('Erro ao salvar. Tente novamente.');
    } finally {
      setSaving(false);
    }
  };

  const pct = Math.round(cluster.cohesion_score * 100);

  return (
    <div className={styles.detailView}>
      <div className={styles.detailHeader}>
        <button className={styles.backBtn} onClick={onBack}>
          <ArrowLeft size={15} />
          Voltar
        </button>
        <div className={styles.detailHeaderInfo}>
          <h2 className={styles.detailTitle}>Pessoa desconhecida</h2>
          <div className={styles.detailSubtitle}>
            <span>{cluster.face_count} foto{cluster.face_count !== 1 ? 's' : ''} agrupadas</span>
            <span className={styles.confidencePill}>{pct}% coesão</span>
            <span className={styles.badgeUnknown} style={{ position: 'static', background: 'none' }}>Desconhecido</span>
          </div>
        </div>
      </div>

      {msg && <div className={styles.feedbackMsg}>{msg}</div>}

      <div className={styles.facesGrid}>
        {cluster.faces.map(face => (
          <FaceThumb key={face.rowid} face={face} />
        ))}
      </div>

      <div className={styles.identifyPanel}>
        <div className={styles.identifyRow}>
          <div className={styles.inputWrap}>
            <input
              className={styles.nameInput}
              placeholder="Nome do formando..."
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAssign()}
              autoFocus
            />
            {suggestions.length > 0 && nameInput.length >= 2 && (
              <div className={styles.suggestionsDropdown}>
                {suggestions.map(s => (
                  <button
                    key={s}
                    className={styles.suggestionItem}
                    onMouseDown={e => {
                      e.preventDefault();
                      setNameInput(s);
                      setSuggestions([]);
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="btn-primary"
            onClick={handleAssign}
            disabled={saving || !nameInput.trim()}
          >
            <Check size={15} />
            {saving ? 'Salvando...' : 'Identificar'}
          </button>
        </div>
        <div className={styles.secondaryActions}>
          <button className="btn-secondary" onClick={onBack}>
            <X size={14} />
            Pular cluster
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Componente principal ──
export default function ReviewView() {
  const { currentCatalog } = useApp();
  const [clusters, setClusters] = useState<RichCluster[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<RichCluster | null>(null);

  const load = useCallback(async () => {
    if (!currentCatalog) return;
    setLoading(true);
    try {
      const data = await api.getUnknownClustersV2(currentCatalog);
      setClusters(data?.clusters ?? []);
    } catch (e) {
      console.error(e);
      setClusters([]);
    } finally {
      setLoading(false);
    }
  }, [currentCatalog]);

  useEffect(() => {
    setSelected(null);
    load();
  }, [load]);

  const handleAssigned = useCallback((clusterId: string) => {
    setClusters(prev => prev.filter(c => c.cluster_id !== clusterId));
    setSelected(null);
  }, []);

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
      {selected ? (
        <ClusterDetailView
          cluster={selected}
          catalog={currentCatalog}
          onBack={() => setSelected(null)}
          onAssigned={handleAssigned}
        />
      ) : (
        <div className={styles.container}>
          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <h1>Revisão IA</h1>
              <p>
                {loading
                  ? 'Calculando grupos...'
                  : clusters.length === 0
                  ? 'Nenhum grupo desconhecido pendente'
                  : `${clusters.length} grupo${clusters.length !== 1 ? 's' : ''} de desconhecidos pendente${clusters.length !== 1 ? 's' : ''}`}
              </p>
            </div>
            <div className={styles.headerActions}>
              <button className="icon-btn" onClick={load} title="Recarregar">
                <RefreshCw size={16} className={loading ? styles.spin : ''} />
              </button>
            </div>
          </div>

          {loading && clusters.length === 0 ? (
            <div className={styles.emptyState}>
              <RefreshCw size={32} className={styles.spin} />
              <p>Calculando agrupamentos...</p>
            </div>
          ) : clusters.length === 0 ? (
            <div className={styles.emptyState}>
              <UserCheck size={48} opacity={0.3} />
              <h3>Tudo identificado!</h3>
              <p>Não há faces desconhecidas pendentes de revisão.</p>
            </div>
          ) : (
            <div className={styles.clusterGrid}>
              {clusters.map(cluster => (
                <ClusterCard
                  key={cluster.cluster_id}
                  cluster={cluster}
                  onClick={setSelected}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
