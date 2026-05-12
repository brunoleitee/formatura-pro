import { useState, useEffect, useCallback } from 'react';
import { Users, RefreshCw, Edit2, Trash2, ChevronRight, Check, X } from 'lucide-react';
import { api, type Person } from '../services/api';
import { useApp } from '../context/AppContext';

interface PeopleViewProps {
  onRequestConfirm: (options: { title: string; message: string; confirmText: string; cancelText: string }) => Promise<boolean>;
}

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

  const filtered = people.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleRename = async (old_id: string) => {
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
  };

  const handleDelete = async (person: Person) => {
    const confirmed = await onRequestConfirm({
      title: 'Excluir formando?',
      message: `Excluir "${person.name}" e todas as suas ocorrências?`,
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
  };

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
        <div className="people-grid">
          {filtered.map(person => (
            <div key={person.id} className="person-card">
              <div
                className="person-avatar"
                onClick={() => navigate('person-detail', person.id)}
              >
                {person.cover_path ? (
                  person.cover_box ? (
                    <img
                      src={api.faceThumbUrl(
                        person.cover_path,
                        person.cover_box[0], person.cover_box[1],
                        person.cover_box[2], person.cover_box[3],
                        160
                      )}
                      alt={person.name}
                    />
                  ) : (
                    <img src={api.thumbUrl(person.cover_path, 160)} alt={person.name} />
                  )
                ) : (
                  <div className="avatar-placeholder">
                    {person.name.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>

              <div className="person-info">
                {renamingId === person.id ? (
                  <div className="rename-inline">
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRename(person.id);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                    />
                    <button className="icon-btn success" onClick={() => handleRename(person.id)}><Check size={14} /></button>
                    <button className="icon-btn" onClick={() => setRenamingId(null)}><X size={14} /></button>
                  </div>
                ) : (
                  <span className="person-name" title={person.name}>{person.name}</span>
                )}
                <span className="person-count">{person.total_photos} foto{person.total_photos !== 1 ? 's' : ''}</span>
              </div>

              <div className="person-actions">
                <button
                  className="icon-btn"
                  title="Ver fotos"
                  onClick={() => navigate('person-detail', person.id)}
                >
                  <ChevronRight size={16} />
                </button>
                <button
                  className="icon-btn"
                  title="Renomear"
                  onClick={() => { setRenamingId(person.id); setRenameValue(person.name); }}
                >
                  <Edit2 size={14} />
                </button>
                <button
                  className="icon-btn danger"
                  title="Excluir"
                  onClick={() => handleDelete(person)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
