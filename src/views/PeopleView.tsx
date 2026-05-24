import { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { Users, RefreshCw, Edit2, Trash2, Check, X, Star, Award, LayoutGrid, List, Search, ExternalLink, Trash, Camera, Merge, UserCheck } from 'lucide-react';
import { api, type Person } from '../services/api';
import { useApp } from '../context/AppContext';
import { resolveAvatarUrl } from '../utils/avatarUrl';
import { isTemporaryPersonId } from '../utils/personIdentity';
import { faceThumb } from '../components/review/FaceCard';
import styles from './PeopleView.module.css';

const getIdentity = (person: Person): string =>
  person.person_key || person.id || person.name;

interface PeopleViewProps {
  onRequestConfirm: (options: { title: string; message: string; confirmText: string; cancelText: string }) => Promise<boolean>;
}

const PersonAvatar = memo(function PersonAvatar({ person }: { person: Person }) {
  const [failed, setFailed] = useState(false);
  const quality = Math.round((person.avg_quality || 0) * 100);

  const avatarUrl = useMemo(() => resolveAvatarUrl(person, 200), [person.cover_path, person.cover_box, person.avatar_path]);

  useEffect(() => { setFailed(false); }, [avatarUrl]);

  return (
    <div className={styles.avatarContainer}>
      <div className={styles.avatarWrap}>
        {!avatarUrl || failed ? (
          <div className={styles.avatarPlaceholder}>{person.name.charAt(0).toUpperCase()}</div>
        ) : (
          <img
            src={avatarUrl}
            alt={person.name}
            loading="eager"
            decoding="async"
            onError={() => setFailed(true)}
          />
        )}
      </div>
      {quality > 0 && <div className={styles.qualityBadge}>{quality}</div>}
    </div>
  );
});

const Collage = memo(function Collage({ person, onPhotoClick }: { person: Person, onPhotoClick?: (path: string) => void }) {
  const photos = (person.sample_photos ?? []);
  if (photos.length === 0) return null;

  return (
    <div className={styles.collage} onClick={e => e.stopPropagation()}>
      {photos.map((sp, i) => (
        <img
          key={i}
          className={styles.collageImg}
          src={faceThumb(sp.path, sp.box, 150)}
          alt=""
          loading="lazy"
          decoding="async"
          onClick={() => onPhotoClick?.(sp.path)}
        />
      ))}
    </div>
  );
});

const PeopleCard = memo(function PeopleCard({
  person,
  viewMode,
  isRenaming,
  renameValue,
  mergeMode,
  mergeSource,
  onOpen,
  onStartRename,
  onCancelRename,
  onRenameValue,
  onConfirmRename,
  onDelete,
  onStartMerge,
  onTargetMerge,
}: {
  person: Person;
  viewMode: 'cards' | 'list';
  isRenaming: boolean;
  renameValue: string;
  mergeMode: 'idle' | 'selecting' | 'merging';
  mergeSource: Person | null;
  onOpen: (id: string) => void;
  onStartRename: (person: Person) => void;
  onCancelRename: () => void;
  onRenameValue: (value: string) => void;
  onConfirmRename: (id: string) => void;
  onDelete: (person: Person) => void;
  onStartMerge: (person: Person) => void;
  onTargetMerge: (person: Person) => void;
}) {
  const quality = Math.round((person.avg_quality || 0) * 100);
  const isList = viewMode === 'list';

  // Hooks do grid (chamados incondicionalmente para respeitar Rules of Hooks)
  const [photoFailed, setPhotoFailed] = useState(false);
  const avatarUrl = useMemo(() => resolveAvatarUrl(person, 200), [person.cover_path, person.cover_box, person.avatar_path]);

  useEffect(() => { setPhotoFailed(false); }, [avatarUrl]);

  const isMergeTarget = mergeMode === 'selecting' && mergeSource && (mergeSource.person_key || mergeSource.id) !== (person.person_key || person.id);

  // ── Modo lista (inalterado) ──
  if (isList) {
    return (
      <div
        className={`${styles.card} ${mergeMode === 'selecting' && mergeSource?.id === person.id ? styles.cardMergeSource : ''} ${isMergeTarget ? styles.cardMergeTarget : ''}`}
        onClick={() => {
          if (mergeMode === 'selecting' && isMergeTarget) { onTargetMerge(person); return; }
          if (!isRenaming) onOpen(person.person_key || person.id);
        }}
      >
        {mergeMode === 'selecting' && isMergeTarget && (
          <div className={styles.mergeTargetOverlay}>
            <UserCheck size={24} />
            <span>Mesclar aqui</span>
          </div>
        )}
        <PersonAvatar person={person} />

        <div className={styles.infoSection}>
          {isRenaming ? (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }} onClick={e => e.stopPropagation()}>
              <input
                className={styles.searchInline}
                autoFocus
                value={renameValue}
                onChange={e => onRenameValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') onConfirmRename(person.id);
                  if (e.key === 'Escape') onCancelRename();
                }}
              />
              <button className="icon-btn success" onClick={() => onConfirmRename(person.id)}><Check size={14} /></button>
              <button className="icon-btn" onClick={onCancelRename}><X size={14} /></button>
            </div>
          ) : (
            <>
              <h3 className={styles.name}>{person.name}</h3>
              <div className={styles.badgesRow} style={{ justifyContent: 'flex-start' }}>
                <span className={styles.idBadge}>ID {(person.person_key || person.id).substring(0, 12)}</span>
                <span className={styles.classBadge}>{person.class_name || 'Sem turma'}</span>
              </div>
              <div className={styles.statsRow} style={{ justifyContent: 'flex-start', gap: '16px' }}>
                <div className={styles.statItem}>
                  <Users size={14} />
                  <span className={`${styles.statValue} ${styles.photos}`}>{person.total_photos} fotos</span>
                </div>
                <div className={styles.statItem}>
                  <Star size={14} />
                  <span className={`${styles.statValue} ${styles.favorites}`}>{person.favorites_count || 0} fav</span>
                </div>
                <div className={styles.statItem}>
                  <Trash size={14} />
                  <span className={`${styles.statValue} ${styles.discarded}`}>{person.discarded_count || 0} descartes</span>
                </div>
                <div className={styles.statItem}>
                  <Award size={14} />
                  <span className={`${styles.statValue} ${styles.quality}`}>{quality}% qualidade IA</span>
                </div>
              </div>
            </>
          )}
        </div>

        <Collage person={person} onPhotoClick={() => onOpen(person.person_key || person.id)} />

        <div className={styles.actionsSection} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <button className={styles.actionBtn} onClick={() => onOpen(person.person_key || person.id)} title="Abrir">
              <ExternalLink size={14} /> Abrir
            </button>
            <button className={styles.actionBtn} onClick={() => onStartRename(person)} title="Renomear">
              <Edit2 size={14} /> Renomear
            </button>
            {mergeMode === 'idle' && (
              <button className={styles.actionBtn} onClick={() => onStartMerge(person)} title="Mesclar">
                <Merge size={14} /> Mesclar
              </button>
            )}
            <button className={`${styles.actionBtn} ${styles.actionBtnDanger}`} onClick={() => onDelete(person)} title="Excluir">
              <Trash2 size={14} /> Excluir
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Modo grid (novo layout) ──
  const qualityColor = quality >= 70 ? '#22c55e' : quality >= 50 ? '#f59e0b' : '#ef4444';
  const discards = person.discarded_count || 0;

  return (
    <div
      className={`${styles.cardCompact} ${mergeMode === 'selecting' && mergeSource?.id === person.id ? styles.cardMergeSource : ''} ${isMergeTarget ? styles.cardMergeTarget : ''}`}
      onClick={() => {
        if (mergeMode === 'selecting' && isMergeTarget) { onTargetMerge(person); return; }
        if (!isRenaming) onOpen(person.person_key || person.id);
      }}
    >
      {mergeMode === 'selecting' && isMergeTarget && (
        <div className={styles.mergeTargetOverlay}>
          <UserCheck size={24} />
          <span>Mesclar aqui</span>
        </div>
      )}
      {/* 1. Área da foto */}
      <div className={styles.gridPhotoArea}>
        {(!avatarUrl || photoFailed) ? (
          <div className={styles.gridPhotoPlaceholder}>
            {person.name.charAt(0).toUpperCase()}{person.name.split(' ').length > 1 ? person.name.split(' ').pop()!.charAt(0).toUpperCase() : ''}
          </div>
        ) : (
          <img
            className={styles.gridPhoto}
            src={avatarUrl}
            alt={person.name}
            loading="eager"
            decoding="async"
            onError={() => setPhotoFailed(true)}
          />
        )}
        <div className={styles.gridPhotoGradient} />

        {/* Badge de qualidade IA */}
        {quality > 0 && (
          <div className={styles.gridQualityBadge}>
            <span className={styles.gridQualityDot} style={{ background: qualityColor }} />
            {quality}%
          </div>
        )}

        {/* Overlay de renomear */}
        {isRenaming && (
          <div className={styles.gridRenameOverlay} onClick={e => e.stopPropagation()}>
            <input
              className={styles.searchInline}
              autoFocus
              value={renameValue}
              onChange={e => onRenameValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') onConfirmRename(person.id);
                if (e.key === 'Escape') onCancelRename();
              }}
              style={{ flex: 1 }}
            />
            <button className="icon-btn success" onClick={() => onConfirmRename(person.id)}><Check size={14} /></button>
            <button className="icon-btn" onClick={onCancelRename}><X size={14} /></button>
          </div>
        )}
      </div>

      {/* 2. Área de info */}
      <div className={styles.gridInfoSection}>
        <h3 className={styles.gridName}>{person.name}</h3>
        <div className={styles.gridId}>{(person.person_key || person.id).substring(0, 12)}</div>
        <div className={styles.gridStatsRow}>
          <div className={styles.gridStatItem} style={{ color: '#a89af7' }}>
            <Camera size={13} />
            {person.total_photos}
          </div>
          <div className={styles.gridStatItem}>
            <Star size={13} />
            {person.favorites_count || 0}
          </div>
          <div className={styles.gridStatItem} style={{ color: discards > 0 ? '#f59e0b' : '#555' }}>
            <Trash size={13} />
            {discards}
          </div>
        </div>
      </div>

      {/* 3. Footer */}
      <div className={styles.gridFooter} onClick={e => e.stopPropagation()}>
        <span className={`${styles.gridClassTag} ${(!person.class_name || person.class_name === 'Sem turma') ? styles.gridClassTagEmpty : ''}`}>
          {person.class_name || 'Sem turma'}
        </span>
        <div className={styles.gridActions}>
          <button className={styles.gridActionBtn} onClick={() => onOpen(person.person_key || person.id)} title="Abrir">
            <ExternalLink size={14} />
          </button>
          <button className={styles.gridActionBtn} onClick={() => onStartRename(person)} title="Renomear">
            <Edit2 size={14} />
          </button>
          {mergeMode === 'idle' && (
            <button className={styles.gridActionBtn} onClick={() => onStartMerge(person)} title="Mesclar">
              <Merge size={14} />
            </button>
          )}
          <button className={`${styles.gridActionBtn} ${styles.gridActionBtnDanger}`} onClick={() => onDelete(person)} title="Excluir">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
});

export default function PeopleView({ onRequestConfirm }: PeopleViewProps) {
  const { currentCatalog, navigate, refreshKey } = useApp();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');

  const [sortBy, setSortBy] = useState<'name' | 'id' | 'photos' | 'quality'>('name');
  const [filterFavorites, setFilterFavorites] = useState(false);
  const [viewMode, setViewMode] = useLocalStorage<'cards' | 'list'>('identifiedViewMode', 'list');
  const [mergeMode, setMergeMode] = useState<'idle' | 'selecting' | 'merging'>('idle');
  const [mergeSource, setMergeSource] = useState<Person | null>(null);
  const [merging, setMerging] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    // Cancelar request anterior se existir
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    if (!currentCatalog) return;
    setLoading(true);
    try {
      const data = await api.getPeople(false, currentCatalog, controller.signal);
      if (!controller.signal.aborted) {
        setPeople(data);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        console.error(e);
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [currentCatalog, refreshKey]);

  useEffect(() => {
    load();
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [load]);

  const handleMergeDuplicates = useCallback(async () => {
    if (!currentCatalog) return;
    const nameGroups = new Map<string, Person[]>();
    for (const p of people) {
      const key = p.name.toLowerCase().trim();
      if (!nameGroups.has(key)) nameGroups.set(key, []);
      nameGroups.get(key)!.push(p);
    }
    const duplicates: Person[][] = [];
    for (const [, group] of nameGroups) {
      if (group.length > 1) duplicates.push(group);
    }
    if (duplicates.length === 0) {
      setError('Nenhum duplicado encontrado.');
      return;
    }
    let merged = 0;
    setMerging(true);
    for (const group of duplicates) {
      const sorted = [...group].sort((a, b) => (b.total_photos || 0) - (a.total_photos || 0));
      const target = sorted[0];
      for (let i = 1; i < sorted.length; i++) {
        const source = sorted[i];
        try {
          await api.mergePeople({ source_person_id: source.person_key || source.id, target_person_id: target.person_key || target.id, catalog: currentCatalog });
          merged++;
        } catch (err) {
          console.error('[merge] erro ao mesclar', source.name, err);
        }
      }
    }
    setMerging(false);
    if (merged > 0) {
      setError(`Mesclados ${merged} grupo(s) de duplicados com sucesso.`);
      await load();
    }
  }, [people, currentCatalog, load]);

  const handleStartMerge = useCallback((person: Person) => {
    setMergeSource(person);
    setMergeMode('selecting');
  }, []);

  const handleTargetMerge = useCallback(async (targetPerson: Person) => {
    if (!mergeSource || !currentCatalog) return;
    const source = mergeSource;
    const sourceId = source.person_key || source.id;
    const targetId = targetPerson.person_key || targetPerson.id;
    if (sourceId === targetId) {
      setMergeMode('idle');
      setMergeSource(null);
      return;
    }
    setMerging(true);
    try {
      await api.mergePeople({ source_person_id: sourceId, target_person_id: targetId, catalog: currentCatalog });
      setError(`"${source.name}" mesclado em "${targetPerson.name}" com sucesso.`);
      await load();
    } catch (err: any) {
      console.error('[merge] erro:', err);
      setError('Erro ao mesclar formandos.');
    }
    setMerging(false);
    setMergeMode('idle');
    setMergeSource(null);
  }, [mergeSource, currentCatalog, load]);

  const handleCancelMerge = useCallback(() => {
    setMergeMode('idle');
    setMergeSource(null);
  }, []);

  const handleOpenPerson = useCallback((id: string) => {
    navigate('person-detail', id);
  }, [navigate]);

  const handleStartRename = useCallback((person: Person) => {
    setRenamingId(person.id);
    setRenameValue(person.name);
  }, []);

  const handleCancelRename = useCallback(() => { setRenamingId(null); }, []);

  const handleRenameValue = useCallback((value: string) => { setRenameValue(value); }, []);

  const handleRenameSubmit = useCallback(async (old_id: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === old_id) { setRenamingId(null); return; }
    setError('');
    try {
      await api.renamePerson(old_id, trimmed);
      await load();
    } catch { setError('Erro ao renomear.'); }
    setRenamingId(null);
  }, [load, renameValue]);

  const handleDeletePerson = useCallback(async (person: Person) => {
    const confirmed = await onRequestConfirm({
      title: 'Excluir formando?',
      message: `Excluir "${person.name}" e todas as suas ocorrencias?`,
      confirmText: 'Excluir',
      cancelText: 'Cancelar',
    });
    if (!confirmed) return;
    try {
      await api.deletePerson(person.id);
      await load();
    } catch { setError('Erro ao excluir.'); }
  }, [load, onRequestConfirm]);

  const filtered = useMemo(() => {
    let result = people.filter(p =>
      !isTemporaryPersonId(p.name) &&
      !isTemporaryPersonId(p.id) &&
      (!search || p.name.toLowerCase().includes(search.toLowerCase()) || p.id.toLowerCase().includes(search.toLowerCase()))
    );

    if (filterFavorites) {
      result = result.filter(p => (p.favorites_count || 0) > 0);
    }

    return result.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'id') {
        const idA = parseInt(a.id) || 0;
        const idB = parseInt(b.id) || 0;
        return idA - idB;
      }
      if (sortBy === 'photos') return (b.total_photos || 0) - (a.total_photos || 0);
      if (sortBy === 'quality') return (b.avg_quality || 0) - (a.avg_quality || 0);
      return 0;
    });
  }, [people, search, filterFavorites, sortBy]);

  return (
    <div className="view-container" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {mergeMode === 'selecting' && mergeSource && (
        <div className={styles.mergeModeBar}>
          <div className={styles.mergeModeBarContent}>
            <Merge size={16} />
            <span>Clique no formando de destino para mesclar <strong>{mergeSource.name}</strong> nele</span>
          </div>
          <button className={styles.mergeModeCancel} onClick={handleCancelMerge} disabled={merging}>
            <X size={16} /> Cancelar
          </button>
        </div>
      )}
      <div className={styles.viewHeader}>
        <div className={styles.headerTitleSection}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Users size={28} />
            <h1>Formandos</h1>
          </div>
          <p>{filtered.length} formandos identificados</p>
        </div>

        <div className={styles.headerActions}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className={styles.searchContainer} style={{ width: '180px' }}>
              <Search size={16} className={styles.searchIcon} />
              <input
                className={styles.searchInline}
                placeholder="Buscar..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: '#111418', borderRadius: '8px', padding: '2px', border: '1px solid #2d323a' }}>
              <select 
                className={styles.sortSelect}
                value={sortBy}
                onChange={e => setSortBy(e.target.value as any)}
                title="Ordenar por"
              >
                <option value="name">Nome (A-Z)</option>
                <option value="id">Nº Identificador</option>
                <option value="photos">Total de Fotos</option>
                <option value="quality">Qualidade IA</option>
              </select>
            </div>

            <button 
              className="icon-btn small"
              style={{ background: filterFavorites ? '#2563eb' : 'transparent', color: filterFavorites ? '#fff' : '#64748b', border: '1px solid #2d323a' }}
              onClick={() => setFilterFavorites(!filterFavorites)}
              title={filterFavorites ? "Mostrando apenas favoritas" : "Filtrar favoritas"}
            >
              <Star size={14} fill={filterFavorites ? "currentColor" : "none"} />
            </button>
          </div>

          <div className={styles.segmentedControl}>
            <button 
              className={`${styles.viewBtn} ${viewMode === 'cards' ? styles.viewBtnActive : ''}`}
              onClick={() => setViewMode('cards')}
              title="Visualização em mosaico"
            >
              <LayoutGrid size={18} />
            </button>
            <button 
              className={`${styles.viewBtn} ${viewMode === 'list' ? styles.viewBtnActive : ''}`}
              onClick={() => setViewMode('list')}
              title="Visualização em lista"
            >
              <List size={18} />
            </button>
            <button
              className={`icon-btn small ${styles.mergeDuplicatesBtn}`}
              onClick={handleMergeDuplicates}
              disabled={merging}
              title="Mesclar duplicados automaticamente"
            >
              <Merge size={14} />
              <span>Mesclar duplicados</span>
            </button>
          </div>

          <button className="icon-btn" onClick={load} title="Atualizar">
            <RefreshCw size={18} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {error && <p className="error-msg">{error}</p>}

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {loading && people.length === 0 ? (
          <div className="empty-state">
            <RefreshCw size={32} className="spin" />
            <p>Carregando formandos...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <Users size={48} opacity={0.3} />
            <h3>Nenhum formando identificado</h3>
            <p>Escaneie uma pasta para identificar as pessoas nas fotos.</p>
          </div>
        ) : (
          <div className={viewMode === 'list' ? styles.grid : styles.gridCards}>
            {filtered.map((person) => {
              if (process.env.NODE_ENV !== 'production') {
                console.debug('[people-card]', { name: person.name, id: person.id, person_key: person.person_key, identity: getIdentity(person) });
              }
              return (
                <PeopleCard
                  key={getIdentity(person)}
                  person={person}
                  viewMode={viewMode}
                  isRenaming={renamingId === getIdentity(person)}
                  renameValue={renameValue}
                  mergeMode={mergeMode}
                  mergeSource={mergeSource}
                  onOpen={handleOpenPerson}
                  onStartRename={handleStartRename}
                  onCancelRename={handleCancelRename}
                  onRenameValue={handleRenameValue}
                  onConfirmRename={handleRenameSubmit}
                  onDelete={handleDeletePerson}
                  onStartMerge={handleStartMerge}
                  onTargetMerge={handleTargetMerge}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
