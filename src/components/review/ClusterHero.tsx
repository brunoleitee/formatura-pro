import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
import { UserPlus, EyeOff, Check, X, Sparkles, Merge, GitCompare } from 'lucide-react';
import type { AssignClusterResponse, RichCluster, StudentMatchPreviewResponse } from '../../services/api';
import { faceThumb } from './FaceCard';
import { formatSimilarity } from '../../utils/format';
import { getSuggestionInfo } from '../../utils/suggestionUtils';
import styles from './ClusterHero.module.css';

interface ClusterHeroProps {
  cluster: RichCluster;
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
  onSearch?: (q: string) => Promise<Array<{ id: string; name: string }>>;
  onAssign?: (alunoId: string | null, nomeFormando: string | null, className?: string | null) => Promise<AssignClusterResponse>;
  onMerge?: () => Promise<void>;
  matchPreview?: StudentMatchPreviewResponse | null;
  compareStudent?: string | null;
  compareSimilarity?: number | null;
  onCompare?: () => void;
}

export interface ClusterHeroHandle {
  startIdentify: () => void;
}

const ClusterHero = forwardRef<ClusterHeroHandle, ClusterHeroProps>(function ClusterHero({
  cluster,
  collapsed = false,
  assignmentState = null,
  onAssigned,
  onSkip,
  onSearch,
  onAssign,
  onMerge,
  matchPreview = null,
  compareStudent = null,
  compareSimilarity = null,
  onCompare,
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
  const compareEnabled = Boolean(
    compareStudent &&
    compareSimilarity != null &&
    Number.isFinite(compareSimilarity) &&
    compareSimilarity >= 0.30 &&
    onCompare
  );

  const loadSuggestions = useCallback(async (q: string) => {
    if (q.length < 2 || !onSearch) { setSuggestions([]); return; }
    try {
      const res = await onSearch(q);
      setSuggestions(res);
    } catch { setSuggestions([]); }
  }, [onSearch]);

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
      if (onAssign) {
        const result = await onAssign(alunoId, nomeFormando);
        onAssigned(result);
      }
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
    if (!cluster.unknown_similar_id || !onMerge) return;
    try {
      await onMerge();
      onSkip();
    } catch {
      setSaveError('Não foi possível mesclar os grupos.');
    }
  }, [onMerge, onSkip]);

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

        {(() => {
          const info = getSuggestionInfo({ ...cluster, isAssigned });
          switch (info.tier) {
            case 'strong':
              return <div className={styles.suggestionRowStrong}><Sparkles size={12} /><span><strong>{info.student}</strong> — {formatSimilarity(info.similarity)}</span></div>;
            case 'possible':
              return <div className={styles.suggestionRow}><Sparkles size={12} /><span>Possível: <strong>{info.student}</strong> — {formatSimilarity(info.similarity)}</span></div>;
            case 'weak':
              return <div className={styles.suggestionRowDebug}><span>Fraco: {info.student} — {formatSimilarity(info.similarity)}</span></div>;
            case 'unknown':
              return <div className={styles.unknownMatchRow}><span>Provável mesmo formando que grupo <strong>#{info.similarNumber}</strong> — {formatSimilarity(info.similarity)}</span></div>;
            case 'none':
              return !isAssigned ? <div className={styles.noSuggestionRow}><span>Sem formandos identificados suficientes</span></div> : null;
          }
        })()}

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
              <div className={styles.btnConfirmContainer}>
                <button
                  className={styles.btnConfirm}
                  onClick={async () => {
                    try {
                      if (onAssign) {
                        const targetClass = matchPreview?.matched_student_folder || '';
                        // Prefer suggested_person_key (computed by the cluster pipeline) over
                        // matchPreview's resolved PK — the preview lookup degrades to a
                        // case-insensitive name match when no PK was passed, which is
                        // ambiguous when two formandos share the same display name.
                        const resolvedPk =
                          cluster.suggested_person_key
                          || matchPreview?.matched_student_person_key
                          || matchPreview?.matched_student_id
                          || cluster.suggested_student!;
                        const result = await onAssign(
                          resolvedPk,
                          matchPreview?.matched_student_name || cluster.suggested_student!,
                          targetClass
                        );
                        if (onAssigned) onAssigned(result);
                      }
                    } catch (err) {
                      console.error('[assignCluster] erro:', err);
                      setSaveError('Não foi possível confirmar. Tente novamente.');
                    }
                  }}
                  type="button"
                >
                  <Check size={16} />
                  <span>Confirmar como {cluster.suggested_student}</span>
                </button>
                {matchPreview && matchPreview.matched_student_photo_path && (
                  <div className={styles.previewTooltip}>
                    <img
                      src={faceThumb(matchPreview.matched_student_photo_path, matchPreview.matched_student_face_box, 120)}
                      alt={cluster.suggested_student || ''}
                      className={styles.previewThumb}
                      onError={e => {
                        const el = e.currentTarget as HTMLImageElement;
                        el.style.display = 'none';
                      }}
                    />
                    <div className={styles.previewMeta}>
                      <span className={styles.previewName}>{matchPreview.matched_student_name || cluster.suggested_student}</span>
                      <span className={styles.previewClass}>{matchPreview.matched_student_folder || 'Sem turma'}</span>
                      <span className={styles.previewSim}>Similaridade: {Math.round((matchPreview.matched_similarity || cluster.suggested_similarity) * 100)}%</span>
                    </div>
                  </div>
                )}
              </div>
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
              className={styles.btnCompare}
              onClick={compareEnabled ? onCompare : undefined}
              type="button"
              disabled={!compareEnabled}
              title={compareEnabled && compareStudent ? `Comparar com ${compareStudent}` : 'Comparar grupo'}
            >
              <GitCompare size={16} />
              <span>Comparar</span>
            </button>
            <button
              className={`${styles.btnSecondary} ${collapsed ? styles.inlineHidden : styles.inlineFlexVisible}`}
              onClick={onSkip}
              type="button"
              disabled={isAssigned}
            >
              <EyeOff size={16} />
              <span>Ignorar grupo</span>
            </button>
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
