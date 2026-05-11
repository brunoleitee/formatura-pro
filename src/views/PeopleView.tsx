import { useState, useEffect, useCallback } from 'react';
import { Users, RefreshCw, Edit2, Trash2, ChevronRight, Check, X } from 'lucide-react';
import { api, type Person } from '../services/api';
import { useApp } from '../context/AppContext';

type FilterType = 'identified' | 'unknown' | 'all';

export default function PeopleView() {
  const { currentCatalog, navigate, refreshKey } = useApp();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');
  const [filterType, setFilterType] = useState<FilterType>('identified');

  const load = useCallback(async () => {
    if (!currentCatalog) return;
    setLoading(true);
    try {
      if (filterType === 'identified') {
        const data = await api.getPeople(false, currentCatalog);
        setPeople(data);
      } else if (filterType === 'unknown') {
        const data = await api.getPeople(true, currentCatalog);
        setPeople(data);
      } else {
        const [idData, unkData] = await Promise.all([
          api.getPeople(false, currentCatalog),
          api.getPeople(true, currentCatalog)
        ]);
        const combined = [...idData, ...unkData];
        const unique = combined.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);
        setPeople(unique);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [currentCatalog, refreshKey, filterType]);

  useEffect(() => { load(); }, [load]);

  const filtered = people.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleRename = async (old_id: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === old_id) { setRenamingId(null); return; }
    setError('');
    try {
      await api.renamePerson(old_id, trimmed, currentCatalog || "");
      await load();
    } catch (e: any) {
      setError(e.message || 'Erro ao renomear.');
    }
    setRenamingId(null);
  };

  const handleDelete = async (person: Person) => {
    if (!window.confirm(`Excluir "${person.name}" e todas as suas ocorrências?`)) return;
    try {
      await api.deletePerson(person.id, currentCatalog || "");
      await load();
    } catch (e: any) {
      setError(e.message || 'Erro ao excluir.');
    }
  };

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h1>Pessoas</h1>
          <p className="view-subtitle">
            {currentCatalog && <><strong>{currentCatalog}</strong> · </>}
            {filtered.length === 1 ? '1 pessoa' : `${filtered.length} pessoas`}
          </p>
        </div>
        <div className="view-header-actions">
          <div className="tab-group" style={{ marginRight: '8px' }}>
            <button
              className={`tab-btn ${filterType === 'identified' ? 'active' : ''}`}
              onClick={() => setFilterType('identified')}
            >
              Identificados
            </button>
            <button
              className={`tab-btn ${filterType === 'unknown' ? 'active' : ''}`}
              onClick={() => setFilterType('unknown')}
            >
              Sem referência
            </button>
            <button
              className={`tab-btn ${filterType === 'all' ? 'active' : ''}`}
              onClick={() => setFilterType('all')}
            >
              Todos
            </button>
          </div>
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
          <h3>Nenhuma pessoa encontrada</h3>
          <p>Tente ajustar os filtros ou escaneie uma pasta.</p>
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
