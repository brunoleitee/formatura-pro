import { Component, type ErrorInfo, type ReactNode, useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { Download, FolderOpen, RefreshCw, Check, Users, X as XIcon, ChevronRight, Camera, HardDrive } from 'lucide-react';
import { api, type Person, type ExportStatus, type ExportSummary } from '../services/api';
import { useApp } from '../context/AppContext';
import ExportFinishModal from '../components/ExportFinishModal';
import { isTemporaryPersonId } from '../utils/personIdentity';
import { resolveAvatarUrl } from '../utils/avatarUrl';
import s from './ExportView.module.css';

type ExportMode = 'copy' | 'move';
type ConflictStrategy = 'copy' | 'skip' | 'overwrite' | 'recreate';
type SortBy = 'az' | 'za' | 'count';
type ExportFormat = 'original' | 'jpg';

const STEPS = [
  { title: 'Seleção', sub: 'Escolha os formandos' },
  { title: 'Destino', sub: 'Onde exportar' },
  { title: 'Organização', sub: 'Como organizar' },
  { title: 'Exportação', sub: 'Configurações finais' },
];

const ExportAvatar = memo(function ExportAvatar({ person, index }: { person: Person; index: number }) {
  const [failed, setFailed] = useState(false);
  const avatarUrl = useMemo(() => resolveAvatarUrl(person, 160), [person.cover_path, person.cover_box, person.avatar_path]);

  useEffect(() => { setFailed(false); }, [avatarUrl]);

  const initials = person.name
    .trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map(p => p.charAt(0).toUpperCase()).join('');
  const label = initials || String(index + 1).padStart(2, '0');

  if (!avatarUrl || failed) return <>{label}</>;

  return (
    <img
      src={avatarUrl}
      alt={person.name}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
    />
  );
});

class ExportViewBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[ExportViewBoundary]', error, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="view-container">
          <div className="view-header"><div><h1>Exportar Fotos</h1></div></div>
          <div className="error-msg">Reabra a aba Exportar ou atualize a tela para tentar novamente.</div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function ExportView() {
  return <ExportViewBoundary><ExportViewContent /></ExportViewBoundary>;
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
  const [exportFormat, setExportFormat] = useState<ExportFormat>('original');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const pollingFailuresRef = useRef(0);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [step, setStep] = useState(1);
  const [sortBy, setSortBy] = useState<SortBy>('az');

  const loadPeopleAbortRef = useRef<AbortController | null>(null);

  const loadPeople = useCallback(async () => {
    // Cancelar request anterior se existir
    if (loadPeopleAbortRef.current) {
      loadPeopleAbortRef.current.abort();
    }
    const controller = new AbortController();
    loadPeopleAbortRef.current = controller;

    if (!currentCatalog) return;
    console.log('[PERF] loadPeople start');
    const start = performance.now();
    setLoading(true);
    try {
      const data = await api.getPeople(false, currentCatalog, controller.signal);
      if (!controller.signal.aborted) {
        setPeople(data);
        const end = performance.now();
        console.log(`[PERF] loadPeople end ${Math.round(end - start)}ms`);
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
  }, [currentCatalog]);

  useEffect(() => {
    loadPeople();
    return () => {
      if (loadPeopleAbortRef.current) {
        loadPeopleAbortRef.current.abort();
      }
    };
  }, [loadPeople]);

  useEffect(() => {
    setSelected(new Set());
    setStatus(null);
    setPolling(false);
    setFinishModalOpen(false);
    setFinishModalData(null);
    setSearch('');
    setSelectedClass('all');
    setOrganizeByClass(false);
    setExportFormat('original');
    pollingFailuresRef.current = 0;
    setError('');
    setStep(1);
  }, [currentCatalog]);

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (cancelled) return;
      try {
        const st = await api.getExportStatus();
        if (cancelled) return;
        setStatus(st);
        pollingFailuresRef.current = 0;
        if (!st.is_exporting && !st.running) {
          setPolling(false);
          return;
        }
      } catch {
        if (cancelled) return;
        pollingFailuresRef.current += 1;
        if (pollingFailuresRef.current >= 3) {
          setPolling(false);
          setError('Não foi possível consultar o status da exportação. Verifique se o backend está ativo.');
          return;
        }
      }
      const delay = status?.progress != null && status.progress >= 90 ? 200 : 800;
      timer = setTimeout(poll, delay);
    };
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [polling, status?.progress]);

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
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const getPersonId = (person: Person) => person.person_key || person.id || person.name || 'Sem_Nome';
  const getPersonLabel = (person: Person) => {
    const label = person.name || person.id || 'Sem nome';
    if (person.class_name && person.class_name !== 'Sem turma') {
      return `${label} · ${person.class_name}`;
    }
    return label;
  };

  const classOptions = useMemo(() => {
    const values = new Set(people.map(p => (p.class_name || 'Sem turma').trim() || 'Sem turma'));
    return ['all', ...Array.from(values).sort((a, b) => a.localeCompare(b))];
  }, [people]);

  const filtered = people.filter(p =>
    !isTemporaryPersonId(p.name) &&
    !isTemporaryPersonId(p.id) &&
    (!search || p.name.toLowerCase().includes(search.toLowerCase())) &&
    (selectedClass === 'all' || (p.class_name || 'Sem turma').trim() === selectedClass)
  );

  const sortedFiltered = [...filtered].sort((a, b) => {
    if (sortBy === 'az') return a.name.localeCompare(b.name);
    if (sortBy === 'za') return b.name.localeCompare(a.name);
    return (b.total_photos || 0) - (a.total_photos || 0);
  });

  const selectAll = () => setSelected(new Set(filtered.map(getPersonId)));
  const clearAll = () => setSelected(new Set());

  const selectedPeople = useMemo(
    () => people.filter(p => selected.has(getPersonId(p))),
     
    [people, selected]
  );
  const totalSelectedPhotos = useMemo(
    () => selectedPeople.reduce((sum, p) => sum + (p.total_photos || 0), 0),
    [selectedPeople]
  );

  const formatSize = (photos: number): string => {
    const bytes = photos * 17 * 1024 * 1024;
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  };

  const handleExport = async () => {
    if (!destPath) { setError('Selecione a pasta de destino.'); return; }
    if (selected.size === 0) { setError('Selecione ao menos uma pessoa.'); return; }
    setError('');
    setFinishModalOpen(false);
    setFinishModalData(null);
    pollingFailuresRef.current = 0;
    try {
      await api.startExport([...selected], destPath, mode, conflict, includeQuality, includeDescarte, organizeByClass, exportFormat);
      setPolling(true);
      const st = await api.getExportStatus().catch(() => null);
      if (st) setStatus(st);
    } catch { setError('Erro ao iniciar exportação.'); }
  };

  const isExporting = status?.is_exporting ?? false;

  const handleOpenFinishPath = useCallback(async (path: string) => {
    await api.openSystemPath(path);
  }, []);

  return (
    <div className="view-container">

      {/* ── Step bar ── */}
      <div className={s.stepBar}>
        {STEPS.map((st, i) => {
          const num = i + 1;
          const isDone = step > num;
          const isActive = step === num;
          return (
            <div key={num} className={s.stepGroup}>
              <div
                className={`${s.stepItem} ${isActive ? s.stepActive : ''} ${isDone ? s.stepDone : ''}`}
                onClick={() => { if (isDone) setStep(num); }}
                role={isDone ? 'button' : undefined}
                tabIndex={isDone ? 0 : undefined}
                onKeyDown={isDone ? (e) => { if (e.key === 'Enter') setStep(num); } : undefined}
              >
                <div className={s.stepCircle}>{isDone ? <Check size={12} /> : num}</div>
                <div className={s.stepText}>
                  <span className={s.stepName}>{st.title}</span>
                  <span className={s.stepSub}>{st.sub}</span>
                </div>
              </div>
              {i < 3 && <div className={`${s.stepConnector} ${isDone ? s.connectorDone : ''}`} />}
            </div>
          );
        })}
      </div>

      {error && <div className="error-msg" style={{ margin: '0 28px 8px' }}><span>{error}</span></div>}

      {/* ── Step 1: Seleção ── */}
      {step === 1 && (
        <div className={s.splitLayout}>
          <div className={s.leftCol}>

            {/* Selected chips */}
            <div className={s.selectedBox}>
              <div className={s.selectedHeader}>
                <span className={s.selectedTitle}>Selecionados</span>
                <span className={s.selectedCount}>{selected.size} formandos</span>
              </div>
              {selected.size > 0 ? (
                <div className={s.chipsScroll}>
                  {selectedPeople.map((p, i) => (
                    <div key={getPersonId(p)} className={s.chip}>
                      <div className={s.chipAvatarWrap}>
                        <div className={s.chipAvatarInner}>
                          <ExportAvatar person={p} index={i} />
                        </div>
                        <button
                          className={s.chipX}
                          onClick={() => toggleSelect(getPersonId(p))}
                          aria-label={`Remover ${p.name}`}
                        >×</button>
                      </div>
                      <span className={s.chipLabel}>{p.name.split(' ')[0].toUpperCase()}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className={s.emptyChips}>Nenhum formando selecionado</div>
              )}
              <div className={s.chipBtns}>
                <button className={s.btnGhost} onClick={selectAll}><Users size={13} /> Selecionar todos</button>
                <button className={s.btnGhost} onClick={clearAll}><XIcon size={13} /> Limpar seleção</button>
              </div>
            </div>

            {/* People list */}
            <div className={s.listBox}>
              <div className={s.listToolbar}>
                <input
                  className={s.searchInput}
                  placeholder="Buscar formando..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                <select className={s.sortSelect} value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)}>
                  <option value="az">Nome (A-Z)</option>
                  <option value="za">Nome (Z-A)</option>
                  <option value="count">Mais fotos</option>
                </select>
              </div>

              {loading ? (
                <div className={s.emptyList}><RefreshCw size={22} className="spin" /></div>
              ) : (
                <div className={s.peopleList}>
                  {sortedFiltered.map((p, index) => {
                    const personId = getPersonId(p);
                    const isSel = selected.has(personId);
                    const quality = p.avg_quality != null ? Math.round(p.avg_quality * 100) : null;
                    return (
                      <button
                        type="button"
                        key={personId}
                        className={`${s.personRow} ${isSel ? s.selected : ''}`}
                        onClick={() => toggleSelect(personId)}
                        aria-pressed={isSel}
                      >
                        <span className={s.personCheck}>
                          <input type="checkbox" checked={isSel} readOnly tabIndex={-1} />
                        </span>
                        <span className={s.personAvatar}>
                          <ExportAvatar person={p} index={index} />
                        </span>
                        <span className={s.personName}>{getPersonLabel(p)}</span>
                        <span className={s.personPhotos}>{p.total_photos} fotos</span>
                        {quality != null && (
                          <span className={s.ratingBadge}>{quality}%</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right column */}
          <div className={s.rightCol}>
            <div className={s.summaryCard}>
              <div className={s.cardTitle}>Resumo da Exportação</div>
              <div className={s.summaryRows}>
                <div className={s.summaryRow}>
                  <div className={s.summaryIcon}><Users size={14} /></div>
                  <span className={s.summaryLabel}>Formandos selecionados</span>
                  <span className={s.summaryValue}>{selected.size}</span>
                </div>
                <div className={s.summaryRow}>
                  <div className={s.summaryIcon}><Camera size={14} /></div>
                  <span className={s.summaryLabel}>Total de fotos</span>
                  <span className={s.summaryValue}>{totalSelectedPhotos}</span>
                </div>
                <div className={s.summaryRow}>
                  <div className={s.summaryIcon}><HardDrive size={14} /></div>
                  <span className={s.summaryLabel}>Tamanho estimado</span>
                  <span className={s.summaryValue}>{formatSize(totalSelectedPhotos)}</span>
                </div>
              </div>
            </div>

            <button className={s.continueBtn} onClick={() => setStep(2)} disabled={selected.size === 0}>
              Continuar <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Destino ── */}
      {step === 2 && (
        <div className={s.stepPage}>
          <div className={s.stepCards}>
            <div className={s.card}>
              <div className={s.cardLabel}>Origem</div>
              <div className={s.cardValue}>{currentCatalog || 'Nenhum catálogo selecionado'}</div>
            </div>
            <div className={s.card}>
              <div className={s.cardLabel}>Destino</div>
              <div className={s.destRow}>
                <input
                  className={s.input}
                  placeholder="C:\Fotos Exportadas\..."
                  value={destPath}
                  onChange={e => setDestPath(e.target.value)}
                />
                <button className={s.btnOutline} onClick={handleSelectFolder}>
                  <FolderOpen size={15} /> Alterar
                </button>
              </div>
            </div>
          </div>
          <div className={s.stepNav}>
            <button className={s.btnSecondary} onClick={() => setStep(1)}>← Voltar</button>
            <button className={s.continueBtn} style={{ width: 'auto' }} onClick={() => setStep(3)} disabled={!destPath}>
              Continuar <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Organização ── */}
      {step === 3 && (
        <div className={s.stepPage}>
          <div className={s.stepCards}>
            <div className={s.card}>
              <div className={s.cardLabel}>Filtrar por turma</div>
              <select className={s.input} value={selectedClass} onChange={e => setSelectedClass(e.target.value)}>
                {classOptions.map(opt => (
                  <option key={opt} value={opt}>{opt === 'all' ? 'Todas as turmas' : opt}</option>
                ))}
              </select>
            </div>
            <div className={s.card}>
              <div className={s.cardLabel}>Organização das pastas</div>
              <label className={s.toggleRow}>
                <input type="checkbox" checked={organizeByClass} onChange={e => setOrganizeByClass(e.target.checked)} />
                <span className={s.toggleLabel}>Organizar por turma</span>
              </label>
            </div>
          </div>
          <div className={s.stepNav}>
            <button className={s.btnSecondary} onClick={() => setStep(2)}>← Voltar</button>
            <button className={s.continueBtn} style={{ width: 'auto' }} onClick={() => setStep(4)}>
              Continuar <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ── Step 4: Exportação ── */}
      {step === 4 && (
        <div className={s.stepPage}>
          {!!status?.export_summary && !isExporting && (
            <div className="export-summary">
              <Check size={20} color="var(--success-color)" />
              <span>Exportação concluída com sucesso!</span>
              <button className="icon-btn" onClick={async () => { try { await api.clearExportSummary(); setStatus(null); } catch { setError('Erro ao limpar resumo'); } }}>✕</button>
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

          <div className={s.configGrid}>
            {/* Formato dos arquivos */}
            <div className={s.card}>
              <div className={s.cardLabel}>Formato dos arquivos</div>
              <div className={s.radioGroup}>
                {([
                  ['original', 'Original (mantém CR2/JPG)'],
                  ['jpg', 'JPEG convertido'],
                ] as const).map(([val, label]) => (
                  <label key={val} className={`${s.radioOpt} ${exportFormat === val ? s.radioActive : ''}`}>
                    <input type="radio" value={val} checked={exportFormat === val} onChange={() => setExportFormat(val)} />
                    <span className={s.radioDot} />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            {/* Modo de exportação */}
            <div className={s.card}>
              <div className={s.cardLabel}>Modo de exportação</div>
              <div className={s.radioGroup}>
                {([['copy', 'Copiar (mantém originais)'], ['move', 'Mover (remove originais)']] as const).map(([val, label]) => (
                  <label key={val} className={`${s.radioOpt} ${mode === val ? s.radioActive : ''}`}>
                    <input type="radio" value={val} checked={mode === val} onChange={() => setMode(val)} />
                    <span className={s.radioDot} />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            {/* Conflito de arquivos */}
            <div className={s.card}>
              <div className={s.cardLabel}>Estratégia de Conflito</div>
              <div className={s.radioGroup}>
                {([
                  ['skip', 'Mesclar (Adicionar fotos novas e atualizar relatórios existentes)'],
                  ['overwrite', 'Substituir (Sobrescrever fotos e relatórios existentes)'],
                  ['recreate', 'Recriar do zero (Limpar a pasta de destino antes de exportar)'],
                  ['copy', 'Renomear automaticamente (Duplica arquivos renomeando com sufixo)'],
                ] as const).map(([val, label]) => (
                  <label key={val} className={`${s.radioOpt} ${conflict === val ? s.radioActive : ''}`}>
                    <input type="radio" value={val} checked={conflict === val} onChange={() => setConflict(val)} />
                    <span className={s.radioDot} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Extras */}
          <div className={s.card}>
            <div className={s.cardLabel}>Extras</div>
            <label className={s.toggleRow}>
              <input type="checkbox" checked={includeDescarte} onChange={e => setIncludeDescarte(e.target.checked)} />
              <span className={s.toggleLabel}>Incluir pasta Descarte (fotos não identificadas)</span>
            </label>
            <label className={s.toggleRow}>
              <input type="checkbox" checked={includeQuality} onChange={e => setIncludeQuality(e.target.checked)} />
              <span className={s.toggleLabel}>Incluir relatório de qualidade</span>
            </label>
          </div>

          <div className={s.stepNav}>
            <button className={s.btnSecondary} onClick={() => setStep(3)} disabled={isExporting}>← Voltar</button>
            <button
              className={s.btnExport}
              onClick={handleExport}
              disabled={isExporting || selected.size === 0 || !destPath}
            >
              {isExporting ? <RefreshCw size={15} className="spin" /> : <Download size={15} />}
              <span>{isExporting ? 'Exportando...' : `Exportar (${selected.size})`}</span>
            </button>
          </div>
        </div>
      )}

      <ExportFinishModal
        open={finishModalOpen}
        exportDir={finishModalData?.exportDir ?? ''}
        pdfPath={finishModalData?.pdfPath ?? ''}
        onClose={() => setFinishModalOpen(false)}
        onOpenPath={handleOpenFinishPath}
      />
    </div>
  );
}
