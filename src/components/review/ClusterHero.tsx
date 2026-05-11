import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UserPlus, EyeOff, MoreHorizontal, Check, X, Sparkles } from 'lucide-react';
import type { RichCluster, SearchResult } from '../../services/api';
import { api } from '../../services/api';
import { faceThumb } from './FaceCard';
import styles from './ClusterHero.module.css';

interface ClusterHeroProps {
  cluster: RichCluster;
  catalog: string;
  onAssigned: (clusterId: string) => void;
  onSkip: () => void;
}

function formatDate(iso?: string) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
      + ' às '
      + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function ClusterHero({
  cluster,
  catalog,
  onAssigned,
  onSkip,
}: ClusterHeroProps) {
  const [identifying, setIdentifying] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [selectedStudent, setSelectedStudent] = useState<{ id: string; name: string } | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ id: string; name: string }>>([]);
  const [isAssigning, setIsAssigning] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const assignLockRef = useRef(false);

  const rep = cluster.representative;
  const pct = Math.round(cluster.cohesion_score * 100);
  const dateStr = formatDate(cluster.discovered_at);

  const loadSuggestions = useCallback(async (q: string) => {
    if (q.length < 2) { setSuggestions([]); return; }
    try {
      const res = await api.globalSearch(q);
      setSuggestions(
        res
           .map((r: SearchResult) => ({ id: r.name, name: r.name }))
           .filter((v, i, a) => a.findIndex((item) => item.id === v.id) === i)
           .slice(0, 6)
      );
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => loadSuggestions(nameInput), 200);
    return () => clearTimeout(t);
  }, [nameInput, loadSuggestions]);

  useEffect(() => {
    setIdentifying(false);
    setNameInput('');
    setSelectedStudent(null);
    setSuggestions([]);
    setSaveError(null);
  }, [cluster.cluster_id]);

  useEffect(() => {
    if (identifying) setTimeout(() => inputRef.current?.focus(), 80);
  }, [identifying]);

  const handleAssign = async () => {
    const typedName = nameInput.trim();
    const alunoId = selectedStudent?.id ?? null;
    const nomeFormando = typedName || null;
    if ((!alunoId && !nomeFormando) || assignLockRef.current) return;

    assignLockRef.current = true;
    setSaveError(null);
    setIsAssigning(true);
    try {
      await api.assignCluster(catalog, {
        cluster_id: cluster.cluster_id,
        aluno_id: alunoId,
        nome_formando: nomeFormando,
      });
      onAssigned(cluster.cluster_id);
    } catch (err) {
      console.error('[assignCluster] erro:', err);
      setSaveError('Não foi possível identificar este grupo. Tente novamente.');
    } finally {
      assignLockRef.current = false;
      setIsAssigning(false);
    }
  };

  const canAssign = Boolean(selectedStudent?.id || nameInput.trim());

  return (
    <div className={styles.hero}>
      {/* Avatar circular */}
      <div className={styles.avatar}>
        {rep ? (
          <img
            src={faceThumb(rep.path, rep.box, 160)}
            alt="Representante"
            className={styles.avatarImg}
          />
        ) : (
          <div className={styles.avatarFallback}>?</div>
        )}
        <div className={styles.avatarRing} />
      </div>

      {/* Coluna de info */}
      <div className={styles.info}>
        {/* Linha do título */}
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Pessoa desconhecida</h1>
          <span className={styles.clusterBadge}>#{cluster.cluster_number}</span>
          <span className={styles.iaBadge}>
            <Sparkles size={10} />
            IA {pct}%
          </span>
        </div>

        {/* Meta */}
        <div className={styles.meta}>
          <span className={styles.metaItem}>
            {cluster.face_count} foto{cluster.face_count !== 1 ? 's' : ''}
          </span>
          <span className={styles.metaDot}>·</span>
          <span className={styles.metaConf}>{pct}% coesão</span>
          {dateStr && (
            <>
              <span className={styles.metaDot}>·</span>
              <span className={styles.metaDate}>Grupo criado em {dateStr}</span>
            </>
          )}
        </div>

        {/* Descrição */}
        <p className={styles.description}>
          <Sparkles size={11} className={styles.descIcon} />
          Grupo descoberto automaticamente pela IA. Selecione as melhores fotos e identifique.
        </p>

        {/* Ações ou identify inline */}
        <AnimatePresence mode="wait">
          {!identifying ? (
            <motion.div
              key="actions"
              className={styles.actions}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
            >
              <button
                className={styles.btnPrimary}
                onClick={() => setIdentifying(true)}
              >
                <UserPlus size={14} />
                Identificar pessoa
              </button>
              <button className={styles.btnSecondary} onClick={onSkip}>
                <EyeOff size={14} />
                Ignorar grupo
              </button>
              <button className={styles.btnIcon} title="Mais ações">
                <MoreHorizontal size={15} />
                Mais ações
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="identify"
              className={styles.identifyInline}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
            >
              <div className={styles.inputWrap}>
                <input
                  ref={inputRef}
                  className={styles.nameInput}
                  placeholder="Digite o nome do formando..."
                  value={nameInput}
                  onChange={e => {
                    const nextValue = e.target.value;
                    setNameInput(nextValue);
                    if (selectedStudent && nextValue.trim() !== selectedStudent.name) {
                      setSelectedStudent(null);
                    }
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleAssign();
                    if (e.key === 'Escape') {
                      setIdentifying(false);
                      setNameInput('');
                      setSelectedStudent(null);
                      setSuggestions([]);
                      setSaveError(null);
                    }
                  }}
                />
                <AnimatePresence>
                  {suggestions.length > 0 && nameInput.length >= 2 && (
                    <motion.div
                      className={styles.suggestions}
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.12 }}
                    >
                      {suggestions.map(s => (
                        <button
                          key={s.id}
                          className={styles.suggestion}
                          onMouseDown={e => {
                            e.preventDefault();
                            setNameInput(s.name);
                            setSelectedStudent(s);
                            setSuggestions([]);
                            inputRef.current?.focus();
                          }}
                        >
                          {s.name}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <button
                className={styles.btnConfirm}
                onClick={handleAssign}
                disabled={isAssigning || !canAssign}
              >
                <Check size={14} />
                {isAssigning ? 'Salvando...' : 'Confirmar'}
              </button>
              <button
                className={styles.btnCancel}
                onClick={() => {
                  setIdentifying(false);
                  setNameInput('');
                  setSelectedStudent(null);
                  setSuggestions([]);
                  setSaveError(null);
                }}
              >
                <X size={14} />
              </button>

              {saveError && (
                <span className={styles.saveError}>{saveError}</span>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
