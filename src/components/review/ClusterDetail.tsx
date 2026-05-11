import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, SkipForward, Grid2x2, LayoutGrid, Users } from 'lucide-react';
import type { RichCluster } from '../../services/api';
import { api } from '../../services/api';
import { FaceCard, faceThumb } from './FaceCard';
import styles from './ClusterDetail.module.css';

type ViewMode = 'gallery' | 'grid';

interface ClusterDetailProps {
  cluster: RichCluster;
  catalog: string;
  onAssigned: (clusterId: string) => void;
  onSkip: () => void;
}

export default function ClusterDetail({
  cluster,
  catalog,
  onAssigned,
  onSkip,
}: ClusterDetailProps) {
  const [mode, setMode] = useState<ViewMode>('gallery');
  const [nameInput, setNameInput] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Sugestões com debounce
  const loadSuggestions = useCallback(async (q: string) => {
    if (q.length < 2) { setSuggestions([]); return; }
    try {
      const res = await api.globalSearch(q);
      setSuggestions(
        res.map((r: { name: string }) => r.name)
           .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
           .slice(0, 6)
      );
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => loadSuggestions(nameInput), 200);
    return () => clearTimeout(t);
  }, [nameInput, loadSuggestions]);

  // Resetar ao mudar cluster
  useEffect(() => {
    setNameInput('');
    setSuggestions([]);
    setMsg('');
    inputRef.current?.focus();
  }, [cluster.cluster_id]);

  const handleAssign = async () => {
    const name = nameInput.trim();
    if (!name || saving) return;
    setSaving(true);
    setMsg('');
    try {
      const rowids = cluster.faces.map(f => f.rowid);
      await api.assignCluster(catalog, cluster.cluster_id, name, rowids);
      setMsg(`${cluster.face_count} foto${cluster.face_count !== 1 ? 's' : ''} identificada${cluster.face_count !== 1 ? 's' : ''} como "${name}"`);
      setNameInput('');
      setSuggestions([]);
      setTimeout(() => onAssigned(cluster.cluster_id), 1000);
    } catch {
      setMsg('Erro ao salvar. Tente novamente.');
    } finally {
      setSaving(false);
    }
  };

  const pct = Math.round(cluster.cohesion_score * 100);
  const rep = cluster.representative;

  return (
    <motion.div
      className={styles.root}
      key={cluster.cluster_id}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.22 }}
    >
      {/* ── Top bar ── */}
      <div className={styles.topBar}>
        <div className={styles.topBarInfo}>
          <div className={styles.topBarTitle}>Pessoa desconhecida</div>
          <div className={styles.topBarMeta}>
            <span className={styles.metaItem}>
              <Users size={12} />
              {cluster.face_count} foto{cluster.face_count !== 1 ? 's' : ''}
            </span>
            <span className={styles.metaDot}>·</span>
            <span className={styles.metaConf}>{pct}% coesão</span>
            <span className={styles.metaBadge}>DESCONHECIDO</span>
          </div>
        </div>

        <div className={styles.topBarActions}>
          <button
            className={`${styles.modeBtn} ${mode === 'gallery' ? styles.modeBtnActive : ''}`}
            onClick={() => setMode('gallery')}
            title="Modo galeria"
          >
            <LayoutGrid size={15} />
          </button>
          <button
            className={`${styles.modeBtn} ${mode === 'grid' ? styles.modeBtnActive : ''}`}
            onClick={() => setMode('grid')}
            title="Modo grid compacto"
          >
            <Grid2x2 size={15} />
          </button>
        </div>
      </div>

      {/* ── Hero face (apenas em gallery) ── */}
      <AnimatePresence>
        {mode === 'gallery' && rep && (
          <motion.div
            className={styles.hero}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.25 }}
          >
            <img
              src={faceThumb(rep.path, rep.box, 500)}
              alt="Rosto representante"
              className={styles.heroImg}
              loading="eager"
            />
            <div className={styles.heroGradient} />
            <div className={styles.heroLabel}>
              <span className={styles.heroLabelMain}>Melhor representante</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Grid de faces ── */}
      <div className={`${styles.grid} ${mode === 'gallery' ? styles.galleryMode : styles.gridMode}`}>
        {cluster.faces.map(face => (
          <FaceCard
            key={face.rowid}
            path={face.path}
            box={face.box}
            variant={mode === 'gallery' ? 'lg' : 'sm'}
          />
        ))}
      </div>

      {/* ── Feedback ── */}
      <AnimatePresence>
        {msg && (
          <motion.div
            className={styles.feedback}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
          >
            {msg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Painel de identificação ── */}
      <div className={styles.identifyPanel}>
        <div className={styles.identifyRow}>
          <div className={styles.inputWrap}>
            <input
              ref={inputRef}
              className={styles.nameInput}
              placeholder="Nome do formando..."
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleAssign();
                if (e.key === 'Escape') { setNameInput(''); setSuggestions([]); }
              }}
            />
            <AnimatePresence>
              {suggestions.length > 0 && nameInput.length >= 2 && (
                <motion.div
                  className={styles.suggestions}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15 }}
                >
                  {suggestions.map(s => (
                    <button
                      key={s}
                      className={styles.suggestion}
                      onMouseDown={e => {
                        e.preventDefault();
                        setNameInput(s);
                        setSuggestions([]);
                        inputRef.current?.focus();
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <button
            className={styles.btnIdentify}
            onClick={handleAssign}
            disabled={saving || !nameInput.trim()}
          >
            <Check size={15} />
            {saving ? 'Salvando...' : 'Identificar'}
          </button>

          <button
            className={styles.btnSkip}
            onClick={onSkip}
            title="Pular grupo"
          >
            <SkipForward size={15} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
