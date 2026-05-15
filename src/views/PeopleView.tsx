import { memo, useState, useEffect, useCallback, useMemo } from 'react';
import { Users, RefreshCw, Edit2, Trash2, Check, X, Star, Trash, Award, Search, ExternalLink, Filter, LayoutGrid, List, Download, ChevronDown } from 'lucide-react';
import { api, type Person } from '../services/api';
import { useApp } from '../context/AppContext';
import { getAvatarThumbUrl } from '../utils/imageUrls';
import { faceThumb } from '../components/review/FaceCard';
import styles from './PeopleView.module.css';

interface PeopleViewProps {
  onRequestConfirm: (options: { title: string; message: string; confirmText: string; cancelText: string }) => Promise<boolean>;
}

const PersonAvatar = memo(function PersonAvatar({ person }: { person: Person }) {
  const [failed, setFailed] = useState(false);
  const quality = Math.round((person.avg_quality || 0) * 100);
  
  const avatarUrl = useMemo(() => {
    // 1. SEMPRE preferir crop de face gerado na hora se tivermos o box (Garante close-up do rosto)
    if (person.cover_path && person.cover_box) {
      return faceThumb(person.cover_path, person.cover_box, 200);
    }
    // 2. Fallback para cache de face (avatar_path)
    if (person.avatar_path) return getAvatarThumbUrl(person.avatar_path);
    // 3. Fallback final para miniatura da foto inteira
    return getAvatarThumbUrl(person.cover_path || '');
  }, [person.avatar_path, person.cover_path, person.cover_box]);

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
  onOpen,
  onStartRename,
  onCancelRename,
  onRenameValue,
  onConfirmRename,
  onDelete,
}: {
  person: Person;
  viewMode: 'cards' | 'list';
  isRenaming: boolean;
  renameValue: string;
  onOpen: (id: string) => void;
  onStartRename: (person: Person) => void;
  onCancelRename: () => void;
  onRenameValue: (value: string) => void;
  onConfirmRename: (id: string) => void;
  onDelete: (person: Person) => void;
}) {
  const quality = Math.round((person.avg_quality || 0) * 100);
  const isList = viewMode === 'list';

  return (
    <div className={isList ? styles.card : styles.cardCompact} onClick={() => !isRenaming && onOpen(person.id)}>
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
            <div className={styles.badgesRow} style={{ justifyContent: isList ? 'flex-start' : 'center' }}>
              <span className={styles.idBadge}>ID {person.id.substring(0, 6)}</span>
              <span className={styles.classBadge}>{person.class_name || 'Sem turma'}</span>
            </div>
            <div className={styles.statsRow} style={{ justifyContent: isList ? 'flex-start' : 'center', flexWrap: isList ? 'nowrap' : 'wrap' }}>
              <div className={styles.statItem}>
                <Users size={14} />
                <span className={`${styles.statValue} ${styles.photos}`}>{person.total_photos} fotos</span>
              </div>
              <div className={styles.statItem}>
                <Star size={14} />
                <span className={`${styles.statValue} ${styles.favorites}`}>{person.favorites_count || 0} favoritas</span>
              </div>
              {isList && (
                <>
                  <div className={styles.statItem}>
                    <Trash size={14} />
                    <span className={`${styles.statValue} ${styles.discarded}`}>{person.discarded_count || 0} descartes</span>
                  </div>
                  <div className={styles.statItem}>
                    <Award size={14} />
                    <span className={`${styles.statValue} ${styles.quality}`}>{quality}% qualidade IA</span>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {isList && <Collage person={person} onPhotoClick={() => onOpen(person.id)} />}

      <div className={isList ? styles.actionsSection : styles.actionsSectionCompact} onClick={e => e.stopPropagation()} style={!isList ? { marginTop: '20px', width: '100%', borderLeft: 'none', borderTop: '1px solid #2a2e35', paddingTop: '12px' } : {}}>
        <div style={{ display: 'flex', flexDirection: isList ? 'column' : 'row', gap: '4px', justifyContent: 'center' }}>
          <button className={styles.actionBtn} onClick={() => onOpen(person.id)} title="Abrir">
            <ExternalLink size={14} /> {isList && 'Abrir'}
          </button>
          <button className={styles.actionBtn} onClick={() => onStartRename(person)} title="Renomear">
            <Edit2 size={14} /> {isList && 'Renomear'}
          </button>
          <button className={`${styles.actionBtn} ${styles.actionBtnDanger}`} onClick={() => onDelete(person)} title="Excluir">
            <Trash2 size={14} /> {isList && 'Excluir'}
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

  // Estados de Visualização
  const [viewMode, setViewMode] = useState<'cards' | 'list'>(() => {
    return (localStorage.getItem('identifiedViewMode') as 'cards' | 'list') || 'list';
  });

  useEffect(() => {
    localStorage.setItem('identifiedViewMode', viewMode);
  }, [viewMode]);

  const load = useCallback(async () => {
    if (!currentCatalog) return;
    setLoading(true);
    try {
      const data = await api.getPeople(false);
      setPeople(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [currentCatalog, refreshKey]);

  useEffect(() => { load(); }, [load]);

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

  const filtered = useMemo(() => people.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.id.toLowerCase().includes(search.toLowerCase())
  ), [people, search]);

  return (
    <div className="view-container" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className={styles.viewHeader}>
        <div className={styles.headerTitleSection}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Users size={28} />
            <h1>Identificados</h1>
          </div>
          <p>{filtered.length} pessoas identificadas</p>
        </div>

        <div className={styles.headerActions}>
          <div className={styles.searchContainer}>
            <Search size={18} className={styles.searchIcon} />
            <input
              className={styles.searchInline}
              placeholder="Buscar por nome ou ID..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <button className={styles.filterBtn}>
            <Filter size={16} /> Filtros
          </button>

          <div className="segmented-control" style={{ display: 'flex', background: '#111418', borderRadius: '8px', padding: '2px', border: '1px solid #2d323a' }}>
            <button 
              className="icon-btn small" 
              style={{ background: viewMode === 'cards' ? '#2563eb' : 'transparent', color: viewMode === 'cards' ? '#fff' : '#64748b' }}
              onClick={() => setViewMode('cards')}
              title="Visualização em cards"
            >
              <LayoutGrid size={16} />
            </button>
            <button 
              className="icon-btn small" 
              style={{ background: viewMode === 'list' ? '#2563eb' : 'transparent', color: viewMode === 'list' ? '#fff' : '#64748b' }}
              onClick={() => setViewMode('list')}
              title="Visualização em lista"
            >
              <List size={16} />
            </button>
          </div>

          <button className="icon-btn" onClick={load} title="Atualizar">
            <RefreshCw size={18} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {error && <p className="error-msg">{error}</p>}

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
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
            {filtered.map((person) => (
              <PeopleCard
                key={person.id || person.name}
                person={person}
                viewMode={viewMode}
                isRenaming={renamingId === person.id}
                renameValue={renameValue}
                onOpen={handleOpenPerson}
                onStartRename={handleStartRename}
                onCancelRename={handleCancelRename}
                onRenameValue={handleRenameValue}
                onConfirmRename={handleRenameSubmit}
                onDelete={handleDeletePerson}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
