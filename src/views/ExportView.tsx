import { Component, type ErrorInfo, type ReactNode, useState, useEffect, useCallback } from 'react';
import { Download, FolderOpen, RefreshCw, Check, Users } from 'lucide-react';
import { api, type Person, type ExportStatus } from '../services/api';
import { useApp } from '../context/AppContext';

type ExportMode = 'copy' | 'move';
type ConflictStrategy = 'copy' | 'skip' | 'overwrite';

class ExportViewBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ExportViewBoundary] render crash:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="view-container">
          <div className="view-header">
            <div>
              <h1>Exportar Fotos</h1>
              <div className="view-subtitle">A aba de exportação encontrou um erro e foi recarregada em modo seguro.</div>
            </div>
          </div>
          <div className="error-msg">Reabra a aba Exportar ou atualize a tela para tentar novamente.</div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function ExportView() {
  return (
    <ExportViewBoundary>
      <ExportViewContent />
    </ExportViewBoundary>
  );
}

function ExportViewContent() {
  const { currentCatalog } = useApp();
  const [people, setPeople] = useState<Person[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [destPath, setDestPath] = useState('');
  const [mode, setMode] = useState<ExportMode>('copy');
  const [conflict, setConflict] = useState<ConflictStrategy>('copy');
  const [includeQuality, setIncludeQuality] = useState(false);
  const [includeDescarte, setIncludeDescarte] = useState(true);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  const loadPeople = useCallback(async () => {
    if (!currentCatalog) return;
    setLoading(true);
    try {
      const data = await api.getPeople(false);
      setPeople(data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [currentCatalog]);

  useEffect(() => { loadPeople(); }, [loadPeople]);

  useEffect(() => {
    setSelected(new Set());
    setStatus(null);
    setPolling(false);
    setSearch('');
    setError('');
  }, [currentCatalog]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (polling) {
      interval = setInterval(async () => {
        const st = await api.getExportStatus().catch(() => null);
        if (st) {
          setStatus(st);
          if (!st.is_exporting) setPolling(false);
        }
      }, 800);
    }
    return () => clearInterval(interval);
  }, [polling]);

  const handleSelectFolder = async () => {
    try {
      const res = await api.selectFolder();
      if (res.path) setDestPath(res.path);
    } catch { setError('Erro ao selecionar pasta.'); }
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const getPersonId = (person: Person) => person.id || person.name || 'Sem_Nome';
  const getPersonInitial = (person: Person) => (person.name || person.id || '?').trim().charAt(0).toUpperCase() || '?';

  const selectAll = () => setSelected(new Set(filtered.map(getPersonId)));
  const clearAll = () => setSelected(new Set());

  const handleExport = async () => {
    if (!destPath) { setError('Selecione a pasta de destino.'); return; }
    if (selected.size === 0) { setError('Selecione ao menos uma pessoa.'); return; }
    setError('');
    try {
      await api.startExport([...selected], destPath, mode, conflict, includeQuality, includeDescarte);
      setPolling(true);
      const st = await api.getExportStatus().catch(() => null);
      if (st) setStatus(st);
    } catch { setError('Erro ao iniciar exportação.'); }
  };

  const filtered = people.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  );

  const isExporting = status?.is_exporting ?? false;

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h1>Exportar Fotos</h1>
          <div className="view-subtitle">Organize as fotos por formando em pastas</div>
        </div>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {!!status?.export_summary && !isExporting && (
        <div className="export-summary">
          <Check size={20} color="var(--success-color)" />
          <span>Exportação concluída com sucesso!</span>
          <button className="icon-btn" onClick={async () => {
            await api.clearExportSummary();
            setStatus(null);
          }}>✕</button>
        </div>
      )}

      {isExporting && status && (
        <div className="export-progress-bar-wrap">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: '0.85rem' }}>{status.status_text}</span>
            <span style={{ fontSize: '0.85rem' }}>{Math.round(status.progress)}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${status.progress}%` }} />
          </div>
        </div>
      )}

      <div className="export-layout">
        <div className="export-people-panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <input
              className="search-inline"
              placeholder="Filtrar formandos..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <button className="btn-secondary" onClick={selectAll} style={{ whiteSpace: 'nowrap' }}>
              <Users size={14} /> Todos
            </button>
            <button className="btn-secondary" onClick={clearAll} style={{ whiteSpace: 'nowrap' }}>
              Limpar
            </button>
          </div>

          {loading ? (
            <div className="empty-state" style={{ padding: 40 }}>
              <RefreshCw size={24} className="spin" />
            </div>
          ) : (
            <div className="export-person-list">
              {filtered.map(p => (
                <button
                  type="button"
                  key={getPersonId(p)}
                  className={`export-person-row ${selected.has(getPersonId(p)) ? 'selected' : ''}`}
                  onClick={() => toggleSelect(getPersonId(p))}
                  aria-pressed={selected.has(getPersonId(p))}
                  style={{
                    width: '100%',
                    border: 'none',
                    background: 'transparent',
                    textAlign: 'left',
                    justifyContent: 'space-between',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 999,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(59,130,246,0.12)',
                        color: 'var(--accent-color)',
                        flexShrink: 0,
                        fontSize: '0.82rem',
                        fontWeight: 700,
                      }}
                    >
                      {getPersonInitial(p)}
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span className="person-name">{p.name || p.id || 'Sem nome'}</span>
                      <span className="person-count">{p.total_photos} fotos</span>
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 18,
                      textAlign: 'center',
                      color: 'var(--accent-color)',
                      fontWeight: 700,
                      visibility: selected.has(getPersonId(p)) ? 'visible' : 'hidden',
                    }}
                  >
                    ✓
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="export-selection-count">
            {selected.size} de {people.length} selecionado{selected.size !== 1 ? 's' : ''}
          </div>
        </div>

        <div className="export-config-panel">
          <h3>Configurações de Exportação</h3>

          <div className="config-section">
            <label className="config-label">Pasta de destino</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="config-input"
                placeholder="C:\Fotos Exportadas\..."
                value={destPath}
                onChange={e => setDestPath(e.target.value)}
              />
              <button className="btn-secondary" onClick={handleSelectFolder}>
                <FolderOpen size={16} />
              </button>
            </div>
          </div>

          <div className="config-section">
            <label className="config-label">Modo de exportação</label>
            <div className="radio-group">
              {([['copy', 'Copiar (mantém originais)'], ['move', 'Mover (remove originais)']] as const).map(([val, label]) => (
                <label key={val} className={`radio-opt ${mode === val ? 'active' : ''}`}>
                  <input type="radio" value={val} checked={mode === val} onChange={() => setMode(val)} />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div className="config-section">
            <label className="config-label">Conflito de arquivos</label>
            <div className="radio-group">
              {([
                ['copy', 'Renomear automaticamente'],
                ['skip', 'Ignorar duplicatas'],
                ['overwrite', 'Substituir'],
              ] as const).map(([val, label]) => (
                <label key={val} className={`radio-opt ${conflict === val ? 'active' : ''}`}>
                  <input type="radio" value={val} checked={conflict === val} onChange={() => setConflict(val)} />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div className="config-section">
            <label className="config-toggle">
              <input
                type="checkbox"
                checked={includeDescarte}
                onChange={e => setIncludeDescarte(e.target.checked)}
              />
              Incluir pasta Descarte (fotos não identificadas)
            </label>
          </div>

          <div className="config-section">
            <label className="config-toggle">
              <input
                type="checkbox"
                checked={includeQuality}
                onChange={e => setIncludeQuality(e.target.checked)}
              />
              Incluir relatório de qualidade
            </label>
          </div>

          <button
            className="btn-primary"
            style={{ width: '100%', justifyContent: 'center', marginTop: 16 }}
            onClick={handleExport}
            disabled={isExporting || selected.size === 0 || !destPath}
          >
            <span style={{ display: 'flex', alignItems: 'center' }}>
              <RefreshCw size={16} className="spin" style={{ display: isExporting ? 'block' : 'none' }} />
              <Download size={16} style={{ display: isExporting ? 'none' : 'block' }} />
            </span>
            {isExporting ? 'Exportando...' : `Exportar${selected.size > 0 ? ` (${selected.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
