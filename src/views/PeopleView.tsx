import { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Users, RefreshCw, Edit2, Trash2, ChevronRight, Check, X, Camera, BookOpen, Image as ImageIcon } from 'lucide-react';
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
  const avatarPath = person.avatar_path || person.cover_path || '';

  useEffect(() => {
    setFailed(false);
  }, [avatarPath]);

  if (!avatarPath || failed) {
    return <div className={styles.avatarPlaceholder}>{person.name.charAt(0).toUpperCase()}</div>;
  }

  return (
    <img
      src={getAvatarThumbUrl(avatarPath) ?? ''}
      alt={person.name}
      loading="eager"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
});

const CoverPhoto = memo(function CoverPhoto({ person }: { person: Person }) {
  const [failed, setFailed] = useState(false);
  const coverPath = person.cover_path || '';
  useEffect(() => { setFailed(false); }, [coverPath]);

  if (!coverPath || failed) {
    return <div className={styles.coverFallback}>{person.name.charAt(0).toUpperCase()}</div>;
  }

  return (
    <img
      className={styles.coverImg}
      src={getAvatarThumbUrl(coverPath) ?? ''}
      alt={person.name}
      loading="eager"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
});

const Collage = memo(function Collage({ person }: { person: Person }) {
  const photos = (person.sample_photos ?? []).slice(0, 4);
  const items: React.ReactNode[] = [];

  for (let i = 0; i < 4; i++) {
    const sp = photos[i];
    if (sp && sp.path && sp.box) {
      items.push(
        <img
          key={i}
          className={styles.collageImg}
          src={faceThumb(sp.path, sp.box, 120)}
          alt=""
          loading="lazy"
          decoding="async"
        />
      );
    } else {
      items.push(<div key={i} className={styles.collagePlaceholder} />);
    }
  }

  return <div className={styles.collage}>{items}</div>;
});

const PeopleCard = memo(function PeopleCard({
  person,
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
  isRenaming: boolean;
  renameValue: string;
  onOpen: (id: string) => void;
  onStartRename: (person: Person) => void;
  onCancelRename: () => void;
  onRenameValue: (value: string) => void;
  onConfirmRename: (id: string) => void;
  onDelete: (person: Person) => void;
}) {
  return (
    <div className={styles.card}>
      <div className={styles.coverWrap} onClick={() => onOpen(person.id)}>
        <CoverPhoto person={person} />
        <div className={styles.avatarOverlay}>
          <PersonAvatar person={person} />
        </div>
      </div>

      <div className={styles.actions}>
        <button className={styles.actionBtn} title="Ver fotos" onClick={() => onOpen(person.id)}>
          <ChevronRight size={15} />
        </button>
        <button className={styles.actionBtn} title="Renomear" onClick={() => onStartRename(person)}>
          <Edit2 size={13} />
        </button>
        <button className={`${styles.actionBtn} ${styles.actionBtnDanger}`} title="Excluir" onClick={() => onDelete(person)}>
          <Trash2 size={13} />
        </button>
      </div>

      <div className={styles.body}>
        {isRenaming ? (
          <>
            <input
              className={styles.renameInput}
              autoFocus
              value={renameValue}
              onChange={e => onRenameValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') onConfirmRename(person.id);
                if (e.key === 'Escape') onCancelRename();
              }}
            />
            <div className={styles.renameActions}>
              <button className={`icon-btn success`} onClick={() => onConfirmRename(person.id)}><Check size={13} /></button>
              <button className={`icon-btn`} onClick={onCancelRename}><X size={13} /></button>
            </div>
          </>
        ) : (
          <>
            <span className={styles.name} title={person.name}>{person.name}</span>
            <div className={styles.meta}>
              <span className={styles.classBadge}>{person.class_name || 'Sem turma'}</span>
              <span>{person.total_photos} foto{person.total_photos !== 1 ? 's' : ''}</span>
            </div>
          </>
        )}
      </div>

      <Collage person={person} />
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

  const handleCancelRename = useCallback(() => {
    setRenamingId(null);
  }, []);

  const handleRenameValue = useCallback((value: string) => {
    setRenameValue(value);
  }, []);

  const handleRenameSubmit = useCallback(async (old_id: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === old_id) { setRenamingId(null); return; }
    setError('');
    try {
      await api.renamePerson(old_id, trimmed);
      await load();
    } catch {
      setError('Erro ao renomear.');
    }
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
    } catch {
      setError('Erro ao excluir.');
    }
  }, [load, onRequestConfirm]);

  const filtered = useMemo(() => people.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  ), [people, search]);

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h1>Formandos Identificados</h1>
          <p className="view-subtitle">
            {currentCatalog && <><strong>{currentCatalog}</strong> · </>}
            {filtered.length === 1 ? '1 pessoa' : `${filtered.length} pessoas`}
          </p>
        </div>
        <div className="view-header-actions">
          <input
            className="search-inline"
            placeholder="Filtrar por nome..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button className="icon-btn" title="Atualizar" onClick={load}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {error && <p className="error-msg">{error}</p>}

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
        <div className={styles.grid}>
          {filtered.map((person) => (
            <PeopleCard
              key={person.id || person.name}
              person={person}
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
  );
}
