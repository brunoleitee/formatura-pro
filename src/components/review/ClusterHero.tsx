import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
import { UserPlus, EyeOff, Check, X, Sparkles, Merge, ChevronUp, ChevronDown } from 'lucide-react';
import type { AssignClusterResponse, RichCluster, SearchResult } from '../../services/api';
import { api } from '../../services/api';
import { faceThumb } from './FaceCard';
import styles from './ClusterHero.module.css';

interface ClusterHeroProps {
  cluster: RichCluster;
  catalog: string;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  assignmentState?: {
    clusterId: string;
    studentName: string;
    className: string;
    status: string;
  } | null;
  onAssigned: (payload: AssignClusterResponse) => void;
  onSkip: () => void;
}

export interface ClusterHeroHandle {
  startIdentify: () => void;
}

const ClusterHero = forwardRef<ClusterHeroHandle, ClusterHeroProps>(function ClusterHero({
  cluster,
  catalog,
  collapsed = false,
  onToggleCollapsed,
  assignmentState = null,
  onAssigned,
  onSkip,
}, ref) {
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
  const showSuggestions = suggestions.length > 0 && nameInput.length >= 2;
  const faceCountLabel = `${cluster.face_count} foto${cluster.face_count !== 1 ? 's' : ''}`;
  const cohesionLabel = `${pct}% coesão`;
  const isAssigned = assignmentState?.clusterId === cluster.cluster_id;

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

  useImperativeHandle(ref, () => ({
    startIdentify: () => setIdentifying(true),
  }), []);

  const handleAssign = async () => {
    const typedName = nameInput.trim();
    const alunoId = selectedStudent?.id ?? null;
    const nomeFormando = typedName || null;
    if ((!alunoId && !nomeFormando) || assignLockRef.current) return;

    assignLockRef.current = true;
    setSaveError(null);
    setIsAssigning(true);
    try {
      const result = await api.assignCluster(catalog, {
        cluster_id: cluster.cluster_id,
        aluno_id: alunoId,
        nome_formando: nomeFormando,
      });
      onAssigned(result);
    } catch (err) {
      console.error('[assignCluster] erro:', err);
      setSaveError('Não foi possível identificar este grupo. Tente novamente.');
    } finally {
      assignLockRef.current = false;
      setIsAssigning(false);
    }
  };

  const canAssign = Boolean(selectedStudent?.id || nameInput.trim());

  const handleMerge = useCallback(async () => {
    if (!cluster.unknown_similar_id) return;
    try {
      await api.mergeCluster(catalog, cluster.cluster_id, cluster.unknown_similar_id);
      onSkip();
    } catch { /* ignore */ }
  }, [cluster.cluster_id, cluster.unknown_similar_id, catalog, onSkip]);

  return (
    <div className={`${styles.hero} ${collapsed ? styles.heroCollapsed : ''} ${isAssigned ? styles.heroAssigned : ''}`}>
      {/* Avatar circular */}
      <div className={`${styles.avatar} ${collapsed ? styles.avatarTiny : ''}`}>
        {rep ? (
          <img
            src={faceThumb(rep.path, rep.box, 120)}
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
        {/* Linha do título + meta em uma linha só */}
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Pessoa {String(cluster.cluster_number).padStart(2, '0')}</h1>
          {isAssigned && (
            <span className={styles.assignedBadge}>
              <Check size={10} />
              <span>Identificado</span>
            </span>
          )}
          {isAssigned && assignmentState?.className && (
            <span className={styles.classBadge}>
              <span>{assignmentState.className}</span>
            </span>
          )}
          <span className={styles.clusterBadge}>#{cluster.cluster_number}</span>
          <span className={styles.iaBadge}>
            <Sparkles size={10} />
            <span>IA {pct}%</span>
          </span>
          <span className={styles.metaDot}>·</span>
          <span className={styles.metaItem}>{faceCountLabel}</span>
          <span className={styles.metaDot}>·</span>
          <span className={styles.metaConf}>{cohesionLabel}</span>
        </div>

        {cluster.suggested_student && cluster.suggested_similarity && cluster.suggested_similarity >= 0.55 && !isAssigned ? (
          <div className={styles.suggestionRowStrong}>
            <Sparkles size={12} />
            <span><strong>{cluster.suggested_student}</strong> — {Math.round(cluster.suggested_similarity * 100)}%</span>
          </div>
        ) : cluster.suggested_student && cluster.suggested_similarity && cluster.suggested_similarity >= 0.45 && !isAssigned ? (
          <div className={styles.suggestionRow}>
            <Sparkles size={12} />
            <span>Possível: <strong>{cluster.suggested_student}</strong> — {Math.round(cluster.suggested_similarity * 100)}%</span>
          </div>
        ) : cluster.best_student_debug && cluster.best_similarity_debug && cluster.best_similarity_debug >= 0.30 && !isAssigned ? (
          <div className={styles.suggestionRowDebug}>
            <span>Fraco: {cluster.best_student_debug} — {Math.round(cluster.best_similarity_debug * 100)}%</span>
          </div>
        ) : cluster.unknown_similar_id && cluster.unknown_similar_number && cluster.unknown_similar_similarity && cluster.unknown_similar_similarity >= 0.55 && !isAssigned ? (
          <div className={styles.unknownMatchRow}>
            <span>Provável mesmo formando que grupo <strong>#{cluster.unknown_similar_number}</strong> — {Math.round(cluster.unknown_similar_similarity * 100)}%</span>
          </div>
        ) : !isAssigned ? (
          <div className={styles.noSuggestionRow}>
            <span>Sem formandos identificados suficientes</span>
          </div>
        ) : null}

        {/* Ações ou identify inline */}
        <div className={`${styles.actions} ${identifying ? styles.blockHidden : styles.blockVisible}`}>
            <button
              className={styles.btnPrimary}
              onClick={() => setIdentifying(true)}
              type="button"
              disabled={isAssigned}
            >
              <UserPlus size={16} />
              <span>Identificar</span>
            </button>
            {cluster.suggested_student && cluster.suggested_similarity && cluster.suggested_similarity >= 0.55 && !isAssigned && !identifying ? (
              <button
                className={styles.btnConfirm}
                onClick={() => {
                  if (onAssigned) onAssigned({
                    cluster_id: cluster.cluster_id,
                    aluno_id: cluster.suggested_student!,
                    nome_formando: cluster.suggested_student!,
                    updated_count: cluster.face_count,
                    status: "assigned",
                    success: true,
                    student_name: cluster.suggested_student ?? null,
                  });
                }}
                type="button"
              >
                <Check size={16} />
                <span>Confirmar como {cluster.suggested_student}</span>
              </button>
            ) : null}
            {cluster.unknown_similar_id && cluster.unknown_similar_similarity && cluster.unknown_similar_similarity >= 0.55 && !isAssigned && !identifying ? (
              <button
                className={styles.btnMerge}
                onClick={handleMerge}
                type="button"
              >
                <Merge size={16} />
                <span>Mesclar com #{cluster.unknown_similar_number}</span>
              </button>
            ) : null}
            <button
              className={`${styles.btnSecondary} ${collapsed ? styles.inlineHidden : styles.inlineFlexVisible}`}
              onClick={onSkip}
              type="button"
              disabled={isAssigned}
            >
              <EyeOff size={16} />
              <span>Ignorar grupo</span>
            </button>
          {onToggleCollapsed && (
            <button
              className={styles.btnIcon}
              onClick={onToggleCollapsed}
              type="button"
              title={collapsed ? 'Expandir detalhes' : 'Recolher detalhes'}
              disabled={isAssigned}
            >
              {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              <span>{collapsed ? 'Expandir' : 'Recolher'}</span>
            </button>
          )}
        </div>

        <div className={`${styles.identifyInline} ${identifying ? styles.blockVisible : styles.blockHidden}`}>
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
            <div className={`${styles.suggestions} ${showSuggestions ? styles.suggestionsVisible : styles.blockHidden}`}>
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
                  type="button"
                >
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
          </div>

          <span className={styles.identifyActions}>
            <button
              className={styles.btnSmallConfirm}
              onClick={handleAssign}
              disabled={isAssigning || !canAssign || isAssigned}
              type="button"
            >
              <Check size={13} />
              <span>{isAssigning ? 'Salvando...' : 'Salvar'}</span>
            </button>
            <button
              className={styles.btnSmallCancel}
              onClick={() => {
                setIdentifying(false);
                setNameInput('');
                setSelectedStudent(null);
                setSuggestions([]);
                setSaveError(null);
              }}
              type="button"
            >
              <X size={14} />
            </button>
          </span>

          <span className={`${styles.saveError} ${saveError ? styles.inlineVisible : styles.inlineHidden}`}>{saveError ?? ''}</span>
        </div>
      </div>
    </div>
  );
});

export default ClusterHero;
