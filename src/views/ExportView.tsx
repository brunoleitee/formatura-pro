import { Component, type ErrorInfo, type ReactNode, useState, useEffect, useCallback, useMemo } from 'react';
import { Download, FolderOpen, RefreshCw, Check, Users } from 'lucide-react';
import { api, type Person, type ExportStatus, type ExportSummary } from '../services/api';
import { useApp } from '../context/AppContext';
import ExportFinishModal from '../components/ExportFinishModal';

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
  const [finishModalOpen, setFinishModalOpen] = useState(false);
  const [finishModalData, setFinishModalData] = useState<{ exportDir: string; pdfPath: string } | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedClass, setSelectedClass] = useState('all');
  const [organizeByClass, setOrganizeByClass] = useState(false);
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
    setFinishModalOpen(false);
    setFinishModalData(null);
    setSearch('');
    setSelectedClass('all');
    setOrganizeByClass(false);
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

  useEffect(() => {
    if (!status || status.is_exporting) return;

    const summary = status.export_summary as ExportSummary | null;
    if (!summary) return;

    const exportId = status.export_id || summary.export_id;
    if (!exportId || typeof window === 'undefined') return;

    const storageKey = 'formaturapro:last-export-modal';
    const seenExportId = window.sessionStorage.getItem(storageKey);
    if (seenExportId === exportId) return;

    window.sessionStorage.setItem(storageKey, exportId);
    setFinishModalData({
      exportDir: status.export_dir || summary.export_dir || summary.dest_path || '',
      pdfPath: status.pdf_path || summary.pdf_path || summary.pdf_report_path || '',
    });
    setFinishModalOpen(true);
  }, [status]);

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
  const getPersonLabel = (person: Person) => person.name || person.id || 'Sem nome';
  const initialsFromName = (name: string) => {
    const parts = name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    if (parts.length === 0) return '';
    return parts.map((part) => part.charAt(0).toUpperCase()).join('');
  };
  const getAvatarLabel = (person: Person, index: number) => {
    if (person.name) {
      const initials = initialsFromName(person.name);
      if (initials) return initials;
    }
    return String(index + 1).padStart(2, '0');
  };
  const getAvatarSrc = (person: Person) => {
    if (!person.cover_path) return null;
    if (person.cover_box) {
      return api.faceThumbUrl(
        person.cover_path,
        person.cover_box[0],
        person.cover_box[1],
        person.cover_box[2],
        person.cover_box[3],
        96
      );
    }
    return api.thumbUrl(person.cover_path, 96);
  };

  const classOptions = useMemo(() => {
    const values = new Set(
      people.map((person) => (person.class_name || 'Sem turma').trim() || 'Sem turma')
    );
    return ['all', ...Array.from(values).sort((a, b) => a.localeCompare(b))];
  }, [people]);

  const selectAll = () => setSelected(new Set(filtered.map(getPersonId)));
  const clearAll = () => setSelected(new Set());

  const handleExport = async () => {
    if (!destPath) { setError('Selecione a pasta de destino.'); return; }
    if (selected.size === 0) { setError('Selecione ao menos uma pessoa.'); return; }
    setError('');
    setFinishModalOpen(false);
    setFinishModalData(null);
    try {
      await api.startExport([...selected], destPath, mode, conflict, includeQuality, includeDescarte, organizeByClass);
      setPolling(true);
      const st = await api.getExportStatus().catch(() => null);
      if (st) setStatus(st);
    } catch { setError('Erro ao iniciar exportação.'); }
  };

  const filtered = people.filter(p =>
    (!search || p.name.toLowerCase().includes(search.toLowerCase())) &&
    (selectedClass === 'all' || (p.class_name || 'Sem turma').trim() === selectedClass)
  );

  const isExporting = status?.is_exporting ?? false;
  const selectionSummary = `${selected.size} de ${people.length} selecionado${selected.size !== 1 ? 's' : ''}`;
  const exportButtonLabel = isExporting ? 'Exportando...' : `Exportar${selected.size > 0 ? ` (${selected.size})` : ''}`;
  const exportSuccessLabel = 'Exportação concluída com sucesso!';

  const finishExportDir = finishModalData?.exportDir ?? '';
  const finishPdfPath = finishModalData?.pdfPath ?? '';

  const handleOpenFinishPath = useCallback(async (path: string) => {
    await api.openSystemPath(path);
  }, []);

  const getRowStyle = (isSelected: boolean) => ({
    width: '100%',
    minHeight: 56,
    borderRadius: 12,
    border: isSelected ? '1px solid rgba(96, 165, 250, 0.9)' : '1px solid rgba(255,255,255,0.04)',
    background: isSelected
      ? 'linear-gradient(180deg, rgba(37,99,235,0.22), rgba(37,99,235,0.10))'
      : 'transparent',
    boxShadow: isSelected
      ? '0 0 0 1px rgba(59,130,246,0.22) inset, 0 12px 28px rgba(37,99,235,0.16)'
      : 'none',
    padding: '10px 12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    textAlign: 'left' as const,
    cursor: 'pointer',
    transition: 'border-color .16s ease, box-shadow .16s ease, transform .16s ease, background .16s ease',
    outline: 'none',
  });

  const getAvatarStyle = (isSelected: boolean) => ({
    width: 32,
    height: 32,
    borderRadius: 10,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    background: isSelected
      ? 'linear-gradient(180deg, rgba(96,165,250,0.26), rgba(59,130,246,0.16))'
      : 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))',
    border: isSelected ? '1px solid rgba(96,165,250,0.36)' : '1px solid rgba(255,255,255,0.06)',
    color: isSelected ? '#dbeafe' : 'rgba(255,255,255,0.88)',
    fontSize: '0.78rem',
    fontWeight: 700,
    letterSpacing: '0.02em',
  });

  const getCheckStyle = (isSelected: boolean) => ({
    width: 18,
    height: 18,
    borderRadius: 6,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    border: isSelected ? '1px solid rgba(96,165,250,0.52)' : '1px solid rgba(255,255,255,0.06)',
    background: isSelected ? 'rgba(59,130,246,0.18)' : 'rgba(255,255,255,0.02)',
    color: isSelected ? '#bfdbfe' : '#64748b',
    boxShadow: isSelected ? '0 0 14px rgba(59,130,246,0.18)' : 'none',
    transition: 'border-color .16s ease, box-shadow .16s ease, transform .16s ease, background .16s ease',
  });

  return (
    <div className="view-container">
      <div className="view-header">
        <div>
          <h1>Exportar Fotos</h1>
          <div className="view-subtitle">
            <span>Organize as fotos por formando em pastas</span>
          </div>
        </div>
      </div>

      {error && <div className="error-msg"><span>{error}</span></div>}

      {!!status?.export_summary && !isExporting && (
        <div className="export-summary">
          <Check size={20} color="var(--success-color)" />
          <span>{exportSuccessLabel}</span>
          <button className="icon-btn" onClick={async () => {
            await api.clearExportSummary();
            setStatus(null);
          }}>✕</button>
        </div>
      )}

      {isExporting && status && (
        <div className="export-progress-bar-wrap">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: '0.85rem' }}>{String(status.status_text || '')}</span>
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
              <Users size={14} />
              <span>Todos</span>
            </button>
            <button className="btn-secondary" onClick={clearAll} style={{ whiteSpace: 'nowrap' }}>
              <span>Limpar</span>
            </button>
          </div>

          {loading ? (
            <div className="empty-state" style={{ padding: 40 }}>
              <RefreshCw size={24} className="spin" />
            </div>
          ) : (
            <div className="export-person-list" style={{ gap: 8, paddingRight: 4 }}>
              {filtered.map((p, index) => {
                const personId = getPersonId(p);
                const isSelected = selected.has(personId);
                const photoCountLabel = `${p.total_photos} fotos`;
                const avatarSrc = getAvatarSrc(p);
                const avatarLabel = getAvatarLabel(p, index);

                return (
                  <button
                    type="button"
                    key={personId}
                    className={`export-person-row ${isSelected ? 'selected' : ''}`}
                    onClick={() => toggleSelect(personId)}
                    aria-pressed={isSelected}
                    style={getRowStyle(isSelected)}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
                      <span aria-hidden="true" style={{ ...getAvatarStyle(isSelected), overflow: 'hidden' }}>
                        {avatarSrc ? (
                          <img
                            src={avatarSrc}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            style={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'cover',
                              display: 'block',
                            }}
                          />
                        ) : (
                          avatarLabel
                        )}
                      </span>
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                        <span
                          className="person-name"
                          style={{
                            fontSize: '0.9rem',
                            fontWeight: 600,
                            color: 'var(--text-primary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          <span>{getPersonLabel(p)}</span>
                        </span>
                        <span
                          className="person-count"
                          style={{
                            fontSize: '0.74rem',
                            color: isSelected ? 'rgba(191,219,254,0.88)' : 'var(--text-secondary)',
                            letterSpacing: '0.01em',
                          }}
                        >
                          <span>{photoCountLabel}</span>
                        </span>
                      </span>
                    </span>
                    <span aria-hidden="true" style={getCheckStyle(isSelected)}>
                      <Check size={12} strokeWidth={2.4} />
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="export-selection-count">
            <span>{selectionSummary}</span>
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
            <label className="config-label">Turma</label>
            <select
              className="config-input"
              value={selectedClass}
              onChange={e => setSelectedClass(e.target.value)}
            >
              {classOptions.map((option) => (
                <option key={option} value={option}>
                  {option === 'all' ? 'Todas as turmas' : option}
                </option>
              ))}
            </select>
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

          <div className="config-section">
            <label className="config-toggle">
              <input
                type="checkbox"
                checked={organizeByClass}
                onChange={e => setOrganizeByClass(e.target.checked)}
              />
              Organizar por turma
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
            <span>{exportButtonLabel}</span>
          </button>
        </div>
      </div>

      <ExportFinishModal
        open={finishModalOpen}
        exportDir={finishExportDir}
        pdfPath={finishPdfPath}
        onClose={() => setFinishModalOpen(false)}
        onOpenPath={handleOpenFinishPath}
      />
    </div>
  );
}
