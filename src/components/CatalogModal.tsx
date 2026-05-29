import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, Edit2, Check, X, FolderOpen, Image, ScanLine, ChevronRight, ArrowLeft, SearchCheck, AlertCircle } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useScan } from '../context/ScanContext';
import { api, catalogApi } from '../services/api';

interface Props {
  onClose: () => void;
  onRequestConfirm: (options: { title: string; message: string; confirmText: string; cancelText: string }) => Promise<boolean>;
}

// step: 'list' → 'pick-folder' → 'pick-flow' → (scanner extras)
type Step = 'list' | 'pick-folder' | 'pick-flow' | 'scanner-config';
type Flow = 'review' | 'scanner';
type EventFolderTreeItem = {
  name: string;
  path: string;
  total_files?: number;
  type?: string;
};

function WizardHeader({
  title,
  onBack,
  createdName,
  onClose,
}: {
  title: string;
  onBack: () => void;
  createdName: string;
  onClose: () => void;
}) {
  return (
    <div className="modal-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="icon-btn" onClick={onBack} title="Voltar" type="button">
          <ArrowLeft size={16} />
        </button>
        <h2 style={{ margin: 0 }}>
          {title}{' '}
          <em style={{ fontStyle: 'normal', color: 'var(--accent)', fontWeight: 700 }}>{createdName}</em>
        </h2>
      </div>
      <button className="icon-btn" onClick={onClose} type="button"><X size={18} /></button>
    </div>
  );
}

export default function CatalogModal({ onClose, onRequestConfirm }: Props) {
  const { catalogs, currentCatalog, setCatalog, refreshCatalogs, navigate, setPendingScanConfig } = useApp();
  const { handleScanStarted } = useScan();

  // ── Passo 1: lista / criação ────────────────────────────────
  const [newName, setNewName]         = useState('');
  const [creating, setCreating]       = useState(false);
  const [renamingId, setRenamingId]   = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError]             = useState('');

  // ── Wizard (passos 2-4) ─────────────────────────────────────
  const [step, setStep]               = useState<Step>('list');
  const [createdName, setCreatedName] = useState('');
  const [rootPath, setRootPath]       = useState('');
  const [refPath, setRefPath]         = useState('');
  const [eventPath, setEventPath]     = useState('');
  const [saving, setSaving]           = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);

  // Detecção automática da pasta de referência
  const [detecting, setDetecting]         = useState(false);
  const [detectedCandidates, setDetectedCandidates] = useState<{ name: string; path: string; found: boolean }[]>([]);
  const [refMode, setRefMode]             = useState<'auto' | 'manual'>('auto');

  // Seleção de subpastas de eventos
  const [eventSubfolders, setEventSubfolders] = useState<Array<{ name: string; path: string; totalFiles: number }>>([]);
  const [selectedSubfolders, setSelectedSubfolders] = useState<string[]>([]);
  const [loadingSubfolders, setLoadingSubfolders] = useState(false);

  // Variações aceitas de nome de pasta de referência (case-insensitive no comparador)
  const REF_CANDIDATE_NAMES = [
    '#referencia', '#Referencia', '#REFERENCIA', 'REFERENCIA', 'referencia',
    '#base', '#Base', '#BASE', 'BASE', 'base',
  ];

  const newNameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { refreshCatalogs(); }, [refreshCatalogs]);

  // Hook reativo para carregar subpastas físicas da pasta de eventos selecionada
  useEffect(() => {
    if (!eventPath) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await api.exploreTree(eventPath, 1);
        if (cancelled) return;

        if (res && res.ok && Array.isArray(res.children)) {
          const subs = (res.children as EventFolderTreeItem[]).filter((c) => c.type === 'folder');
          const enriched = await Promise.all(subs.map(async (c) => {
            try {
              const photosRes = await api.explorePhotos(c.path, { recursive: true, limit: 0, include_raw: true });
              return {
                name: c.name,
                path: c.path,
                totalFiles: photosRes.total || c.total_files || 0
              };
            } catch {
              return {
                name: c.name,
                path: c.path,
                totalFiles: c.total_files || 0
              };
            }
          }));
          if (cancelled) return;
          setEventSubfolders(enriched);
          // Por padrão, seleciona todas as subpastas encontradas
          setSelectedSubfolders(enriched.map(s => s.path));
        } else {
          setEventSubfolders([]);
          setSelectedSubfolders([]);
        }
      } catch {
        if (cancelled) return;
        setEventSubfolders([]);
        setSelectedSubfolders([]);
      } finally {
        if (!cancelled) setLoadingSubfolders(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [eventPath]);

  // Escape: volta passo a passo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (step === 'scanner-config') { setStep('pick-flow'); }
      else if (step === 'pick-flow')   { setStep('pick-folder'); }
      else if (step === 'pick-folder') { setStep('list'); }
      else                              { onClose(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, step]);

  // ─── Criar catálogo (passo 1 → 2) ───────────────────────────
  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) { setError('Por favor, digite o nome do catálogo/evento.'); return; }
    setCreating(true);
    setError('');
    try {
      await api.setCatalog(trimmed);
      await refreshCatalogs();
      await setCatalog(trimmed);
      setNewName('');
      setCreatedName(trimmed);
      setRootPath('');
      setRefPath('');
      setEventPath('');
      setStep('pick-folder');           // ← vai para etapa de pasta
    } catch {
      setError('Não foi possível criar o evento. Verifique o nome.');
    } finally {
      setCreating(false);
    }
  };

  const handleSelect = async (name: string) => {
    await setCatalog(name);
    onClose();
  };

  const handleRenameConfirm = async (oldName: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === oldName) { setRenamingId(null); return; }
    try {
      await api.renameCatalog(oldName, trimmed);
      await refreshCatalogs();
      if (currentCatalog === oldName) await setCatalog(trimmed);
    } catch {
      setError('Erro ao renomear.');
    }
    setRenamingId(null);
  };

  const handleDelete = async (name: string) => {
    const confirmed = await onRequestConfirm({
      title: 'Excluir evento?',
      message: `Excluir o evento "${name}"? Esta ação não pode ser desfeita.`,
      confirmText: 'Excluir',
      cancelText: 'Cancelar',
    });
    if (!confirmed) return;
    try {
      await api.deleteCatalog(name);
      await refreshCatalogs();
    } catch {
      setError('Erro ao excluir.');
    }
  };

  // ─── Seleção de pasta raiz (passo 2) ────────────────────────
  const pickFolder = async (): Promise<string> => {
    setPickingFolder(true);
    try {
      const res = await api.selectFolder().catch(() => null);
      return res?.path || '';
    } finally {
      setPickingFolder(false);
    }
  };

  const handlePickRoot = async () => {
    const path = await pickFolder();
    if (!path) return;
    setRootPath(path);
    setRefPath('');
    setDetectedCandidates([]);
  };

  // Detecta automaticamente a pasta de referência via listagem do backend
  const detectRefFolder = async (root: string) => {
    if (!root) return;
    setDetecting(true);
    setDetectedCandidates([]);
    setRefPath('');
    try {
      const tree = await api.exploreTree(root, 1).catch(() => null);
      // A árvore retorna { children: FolderTreeItem[] } — cada item tem { name, path }
      const children = tree?.children ?? [];
      const sep = root.includes('\\') ? '\\' : '/';
      const rootNorm = root.replace(/[\\/]+$/, '');

      const candidates = REF_CANDIDATE_NAMES.map(candidateName => {
        // Compara ignorando maiúsculas/minúsculas com o campo `name` de cada filho
        const match = children.find(
          (c: { name: string; path: string }) =>
            c.name.toLowerCase() === candidateName.toLowerCase()
        );
        return {
          name: candidateName,
          // Usa o path real do backend se encontrado, senão constrói o esperado
          path: match ? match.path : rootNorm + sep + candidateName,
          found: !!match,
        };
      });

      // Remove duplicatas de path entre os encontrados (mesmo nome diferente em case)
      const seen = new Set<string>();
      const deduped = candidates.filter(c => {
        if (c.found) {
          const key = c.path.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
        }
        return true;
      });

      setDetectedCandidates(deduped);

      // Seleciona automaticamente o primeiro encontrado
      const first = deduped.find(c => c.found);
      if (first) setRefPath(first.path);
    } catch {
      setDetectedCandidates([]);
    } finally {
      setDetecting(false);
    }
  };

  // Avança do passo 2 para o passo 3
  const handleRootConfirm = () => {
    if (!rootPath) { setError('Selecione a pasta do curso antes de continuar.'); return; }
    setError('');
    setStep('pick-flow');
  };

  // ─── Escolha de fluxo (passo 3) ─────────────────────────────
  const handleFlowSelect = (chosen: Flow) => {
    if (chosen === 'scanner') {
      setStep('scanner-config');
      // Inicia detecção automática ao entrar no passo
      if (rootPath) detectRefFolder(rootPath);
    } else {
      // Revisar: basta ter a pasta raiz → salvar e abrir galeria
      handleSave('review');
    }
  };

  // ─── Config extra do Scanner (passo 4) ──────────────────────
  const handlePickRef = async () => {
    const p = await pickFolder();
    if (p) { setRefPath(p); setRefMode('manual'); }
  };
  const handlePickEvent = async () => {
    const p = await pickFolder();
    if (p) {
      setLoadingSubfolders(true);
      setEventPath(p);
    }
  };

  // ─── Salvar e finalizar ──────────────────────────────────────
  const handleSave = async (chosenFlow: Flow) => {
    if (!createdName) return;
    setSaving(true);
    setError('');
    try {
      if (rootPath) {
        await catalogApi.saveCatalogSettings(createdName, { root_path: rootPath });
      }
      if (chosenFlow === 'review' && rootPath) {
        await catalogApi.addFolder(createdName, rootPath, true, false, 'event');
      }
      if (chosenFlow === 'scanner') {
        if (eventPath) await catalogApi.addFolder(createdName, eventPath, true, false, 'event');
        if (refPath)   await catalogApi.addFolder(createdName, refPath,   true, false, 'reference');

        // Inicia o scan imediatamente
        await api.scanFolder(eventPath, refPath || '', createdName, {
          selected_folders: selectedSubfolders
        });
        handleScanStarted({ catalogName: createdName, oriPath: eventPath, refPath: refPath || '' });
        setPendingScanConfig({ eventPath, refPath: refPath || '', catalogName: createdName });
      }
      onClose();
      navigate(chosenFlow === 'scanner' ? 'scanner' : 'photos');
    } catch {
      setError('Erro ao salvar configurações. Verifique os caminhos.');
    } finally {
      setSaving(false);
    }
  };

  // ────────────────────────────────────────────────────────────
  // RENDERS
  // ────────────────────────────────────────────────────────────

  // ── PASSO 2: Selecionar pasta do curso ─────────────────────
  if (step === 'pick-folder') {
    return (
      <div className="modal-overlay">
        <div className="modal-box modal-box-wizard">
          <WizardHeader title="Pasta do curso —" onBack={() => setStep('list')} createdName={createdName} onClose={onClose} />

          <div className="wizard-step-indicator">
            <span className="wizard-step active">1. Nome</span>
            <ChevronRight size={12} className="wizard-step-sep" />
            <span className="wizard-step active current">2. Pasta</span>
            <ChevronRight size={12} className="wizard-step-sep" />
            <span className="wizard-step">3. Fluxo</span>
          </div>

          <div className="wizard-fields">
            <div className="wizard-field-group">
              <label className="wizard-label">Pasta raiz do curso</label>
              <p className="wizard-label-desc">
                Selecione a pasta principal que contém todas as fotos e eventos deste curso
                (ex.: <code>Formatura Medicina Unipac 2025</code>).
              </p>

              <div className="wizard-folder-row">
                <div className="wizard-folder-display">
                  <FolderOpen size={14} />
                  <span className={rootPath ? 'wizard-path-value' : 'wizard-path-placeholder'}>
                    {rootPath || 'Nenhuma pasta selecionada...'}
                  </span>
                </div>
                <button
                  className="btn-outline-sm"
                  onClick={handlePickRoot}
                  disabled={pickingFolder}
                  type="button"
                >
                  {pickingFolder ? 'Abrindo...' : 'Selecionar'}
                </button>
              </div>
            </div>
          </div>

          {error && <p className="modal-error">{error}</p>}

          <div className="wizard-footer">
            <button className="btn-ghost" onClick={() => setStep('list')} type="button">
              Voltar
            </button>
            <button
              className="btn-primary"
              onClick={handleRootConfirm}
              disabled={!rootPath}
              type="button"
            >
              Próximo
            </button>
            <button
              className="btn-ghost"
              onClick={() => { setStep('pick-flow'); }}
              type="button"
              style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginLeft: 'auto' }}
            >
              Pular etapa
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── PASSO 3: Escolher fluxo ────────────────────────────────
  if (step === 'pick-flow') {
    return (
      <div className="modal-overlay">
        <div className="modal-box modal-box-wizard">
          <WizardHeader title="Como prosseguir com" onBack={() => setStep('pick-folder')} createdName={createdName} onClose={onClose} />

          <div className="wizard-step-indicator">
            <span className="wizard-step active">1. Nome</span>
            <ChevronRight size={12} className="wizard-step-sep" />
            <span className="wizard-step active">2. Pasta</span>
            <ChevronRight size={12} className="wizard-step-sep" />
            <span className="wizard-step active current">3. Fluxo</span>
          </div>

          {rootPath && (
            <div className="wizard-root-summary">
              <FolderOpen size={13} />
              <span>{rootPath}</span>
            </div>
          )}

          <div className="wizard-flow-grid">
            <button
              className="wizard-flow-card"
              onClick={() => handleFlowSelect('review')}
              disabled={saving}
              type="button"
            >
              <div className="wizard-flow-icon">
                <Image size={28} />
              </div>
              <div className="wizard-flow-info">
                <span className="wizard-flow-title">Revisar e Organizar</span>
                <span className="wizard-flow-desc">
                  Navegue pelas fotos, descarte duplicadas e organize os eventos do curso.
                </span>
              </div>
              <ChevronRight size={18} className="wizard-flow-arrow" />
            </button>

            <button
              className="wizard-flow-card"
              onClick={() => handleFlowSelect('scanner')}
              disabled={saving}
              type="button"
            >
              <div className="wizard-flow-icon wizard-flow-icon-scanner">
                <ScanLine size={28} />
              </div>
              <div className="wizard-flow-info">
                <span className="wizard-flow-title">Reconhecimento Facial</span>
                <span className="wizard-flow-desc">
                  Configure pastas de referência e eventos para identificar formandos automaticamente.
                </span>
              </div>
              <ChevronRight size={18} className="wizard-flow-arrow" />
            </button>
          </div>

          {saving && <p className="wizard-saving-msg">Salvando configurações...</p>}
          {error && <p className="modal-error">{error}</p>}

          <div className="wizard-footer" style={{ justifyContent: 'space-between' }}>
            <button className="btn-ghost" onClick={() => setStep('pick-folder')} type="button">
              Voltar
            </button>
            <button
              className="btn-ghost"
              onClick={onClose}
              type="button"
              style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}
            >
              Configurar depois
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── PASSO 4: Configuração extra do Scanner ─────────────────
  if (step === 'scanner-config') {
    return (
      <div className="modal-overlay">
        <div className="modal-box modal-box-wizard">
          <WizardHeader title="Scanner —" onBack={() => setStep('pick-flow')} createdName={createdName} onClose={onClose} />

          <div className="wizard-step-indicator">
            <span className="wizard-step active">1. Nome</span>
            <ChevronRight size={12} className="wizard-step-sep" />
            <span className="wizard-step active">2. Pasta</span>
            <ChevronRight size={12} className="wizard-step-sep" />
            <span className="wizard-step active">3. Fluxo</span>
            <ChevronRight size={12} className="wizard-step-sep" />
            <span className="wizard-step active current">4. Scanner</span>
          </div>

          <div className="wizard-fields">
            {/* Pasta de Referência */}
            <div className="wizard-field-group">
              <label className="wizard-label">Pasta de Referências (IDs dos Alunos)</label>
              <p className="wizard-label-desc">
                Fotos de identificação dos formandos usadas para o reconhecimento facial.
              </p>

              {/* Abas: Auto / Manual */}
              <div className="wizard-ref-tabs">
                <button
                  className={`wizard-ref-tab ${refMode === 'auto' ? 'active' : ''}`}
                  onClick={() => { setRefMode('auto'); if (rootPath && detectedCandidates.length === 0) detectRefFolder(rootPath); }}
                  type="button"
                >
                  <SearchCheck size={13} />
                  Detectar automaticamente
                </button>
                <button
                  className={`wizard-ref-tab ${refMode === 'manual' ? 'active' : ''}`}
                  onClick={() => setRefMode('manual')}
                  type="button"
                >
                  <FolderOpen size={13} />
                  Selecionar manualmente
                </button>
              </div>

              {/* Modo: Automático */}
              {refMode === 'auto' && (
                <div className="wizard-ref-auto-panel">
                  {detecting && (
                    <div className="wizard-detecting-msg">
                      <span className="spin" style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid var(--accent)', borderTopColor: 'transparent', borderRadius: '50%' }} />
                      Procurando pasta de referência...
                    </div>
                  )}

                  {!detecting && detectedCandidates.length === 0 && (
                    <div className="wizard-no-root-hint">
                      <AlertCircle size={13} />
                      {rootPath
                        ? <span>Clique em <strong>Detectar</strong> para buscar automaticamente.</span>
                        : <span>Selecione a pasta raiz no passo 2 primeiro.</span>}
                      {rootPath && (
                        <button className="btn-outline-sm" style={{ marginLeft: 'auto' }} onClick={() => detectRefFolder(rootPath)} type="button">
                          Detectar
                        </button>
                      )}
                    </div>
                  )}

                  {!detecting && detectedCandidates.length > 0 && (
                    <div className="wizard-candidates">
                      {/* Encontradas */}
                      {detectedCandidates.filter(c => c.found).length > 0 && (
                        <>
                          <p className="wizard-candidates-label wizard-candidates-found-label">✓ Encontradas na pasta do curso</p>
                          {detectedCandidates.filter(c => c.found).map(c => (
                            <button
                              key={c.name}
                              className={`wizard-candidate-row wizard-candidate-found ${refPath === c.path ? 'selected' : ''}`}
                              onClick={() => setRefPath(c.path)}
                              type="button"
                            >
                              <FolderOpen size={13} />
                              <span className="wizard-candidate-name">{c.name}</span>
                              <span className="wizard-candidate-path">{c.path}</span>
                              {refPath === c.path && <Check size={13} className="wizard-candidate-check" />}
                            </button>
                          ))}
                        </>
                      )}

                      {/* Não encontradas — mostrar colapsado */}
                      {detectedCandidates.filter(c => !c.found).length > 0 && (
                        <details className="wizard-candidates-others">
                          <summary className="wizard-candidates-label">Não encontradas — usar mesmo assim</summary>
                          {detectedCandidates.filter(c => !c.found).map(c => (
                            <button
                              key={c.name}
                              className={`wizard-candidate-row ${refPath === c.path ? 'selected' : ''}`}
                              onClick={() => setRefPath(c.path)}
                              type="button"
                            >
                              <FolderOpen size={13} style={{ opacity: 0.4 }} />
                              <span className="wizard-candidate-name" style={{ opacity: 0.55 }}>{c.name}</span>
                              {refPath === c.path && <Check size={13} className="wizard-candidate-check" />}
                            </button>
                          ))}
                        </details>
                      )}

                      <button
                        className="wizard-redetect-btn"
                        onClick={() => detectRefFolder(rootPath)}
                        disabled={detecting}
                        type="button"
                      >
                        Buscar novamente
                      </button>
                    </div>
                  )}

                  {refPath && refMode === 'auto' && (
                    <div className="wizard-auto-path" style={{ marginTop: 8 }}>
                      <FolderOpen size={12} />
                      <span>Selecionada: {refPath}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Modo: Manual */}
              {refMode === 'manual' && (
                <div className="wizard-folder-row" style={{ marginTop: 6 }}>
                  <div className="wizard-folder-display">
                    <FolderOpen size={14} />
                    <span className={refPath ? 'wizard-path-value' : 'wizard-path-placeholder'}>
                      {refPath || 'Nenhuma pasta selecionada...'}
                    </span>
                  </div>
                  <button className="btn-outline-sm" onClick={handlePickRef} disabled={pickingFolder} type="button">
                    {pickingFolder ? 'Abrindo...' : 'Selecionar'}
                  </button>
                </div>
              )}
            </div>

            {/* Pasta dos Eventos */}
            <div className="wizard-field-group">
              <label className="wizard-label">Pasta dos Eventos</label>
              <p className="wizard-label-desc">
                Fotos da colação, baile, etc. que serão escaneadas para identificar os formandos.
              </p>
              <div className="wizard-folder-row">
                <div className="wizard-folder-display">
                  <FolderOpen size={14} />
                  <span className={eventPath ? 'wizard-path-value' : 'wizard-path-placeholder'}>
                    {eventPath || 'Nenhuma pasta selecionada...'}
                  </span>
                </div>
                <button className="btn-outline-sm" onClick={handlePickEvent} disabled={pickingFolder} type="button">
                  {pickingFolder ? 'Abrindo...' : 'Selecionar'}
                </button>
              </div>

              {/* Seleção de Subpastas de Eventos com Visual Premium */}
              {loadingSubfolders && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  <span className="spin" style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid var(--accent)', borderTopColor: 'transparent', borderRadius: '50%' }} />
                  Carregando subpastas...
                </div>
              )}

              {!loadingSubfolders && eventSubfolders.length > 0 && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>Confirmar pastas do Evento para incluir no scan:</span>
                  </label>
                  <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>
                    Selecione as subpastas que deseja processar (segure Ctrl para múltiplos cliques).
                  </p>

                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    maxHeight: 140,
                    overflowY: 'auto',
                    padding: '8px 10px',
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    borderRadius: 8,
                    marginTop: 4
                  }}>
                    {eventSubfolders.map(sub => {
                      const isSelected = selectedSubfolders.includes(sub.path);
                      return (
                        <label
                          key={sub.path}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 8px',
                            borderRadius: 6,
                            background: isSelected ? 'rgba(236, 72, 153, 0.08)' : 'transparent',
                            border: `1px solid ${isSelected ? 'rgba(236, 72, 153, 0.2)' : 'transparent'}`,
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            userSelect: 'none'
                          }}
                          onClick={(e) => {
                            e.preventDefault();
                            setSelectedSubfolders(prev => {
                              if (prev.includes(sub.path)) {
                                return prev.filter(p => p !== sub.path);
                              } else {
                                return [...prev, sub.path];
                              }
                            });
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            readOnly
                            style={{
                              accentColor: 'var(--accent)',
                              cursor: 'pointer',
                              width: 14,
                              height: 14,
                              margin: 0
                            }}
                          />
                          <FolderOpen size={13} style={{ color: isSelected ? 'var(--accent)' : 'var(--text-muted)' }} />
                          <span style={{ fontSize: '0.78rem', fontWeight: isSelected ? 500 : 400, color: isSelected ? 'var(--text)' : 'var(--text-muted)' }}>
                            {sub.name}
                          </span>
                          <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                            {sub.totalFiles} fotos
                          </span>
                        </label>
                      );
                    })}
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                    <button
                      type="button"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--accent)',
                        fontSize: '0.72rem',
                        cursor: 'pointer',
                        padding: 0,
                        fontWeight: 500
                      }}
                      onClick={() => setSelectedSubfolders(eventSubfolders.map(s => s.path))}
                    >
                      Selecionar Todas
                    </button>
                    <span style={{ color: 'rgba(255, 255, 255, 0.15)', fontSize: '0.72rem' }}>|</span>
                    <button
                      type="button"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-muted)',
                        fontSize: '0.72rem',
                        cursor: 'pointer',
                        padding: 0
                      }}
                      onClick={() => setSelectedSubfolders([])}
                    >
                      Desmarcar Todas
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {error && <p className="modal-error">{error}</p>}

          <div className="wizard-footer">
            <button className="btn-ghost" onClick={() => setStep('pick-flow')} type="button">
              Voltar
            </button>
            <button
              className="btn-primary"
              onClick={() => handleSave('scanner')}
              disabled={saving || !eventPath}
              type="button"
            >
              {saving ? '⏳ Iniciando scan...' : '▶ Iniciar Scanner'}
            </button>
            <button
              className="btn-ghost"
              onClick={onClose}
              type="button"
              style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginLeft: 'auto' }}
            >
              Configurar depois
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── PASSO 1: Lista e criação ───────────────────────────────
  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <div className="modal-header">
          <h2>Selecionar Evento / Catálogo</h2>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>

        {catalogs.length === 0 ? (
          <div className="empty-catalog-container">
            <button
              className="create-catalog-card"
              onClick={() => newNameInputRef.current?.focus()}
              type="button"
            >
              <div className="plus-icon-circle">
                <Plus size={28} />
              </div>
              <span className="card-label">Novo Catálogo</span>
            </button>
          </div>
        ) : (
          <div className="catalog-list">
            {catalogs.map(cat => (
              <div key={cat} className={`catalog-item ${cat === currentCatalog ? 'active' : ''}`}>
                {renamingId === cat ? (
                  <div className="catalog-rename">
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRenameConfirm(cat);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                    />
                    <button className="icon-btn success" onClick={() => handleRenameConfirm(cat)}><Check size={16} /></button>
                    <button className="icon-btn" onClick={() => setRenamingId(null)}><X size={16} /></button>
                  </div>
                ) : (
                  <>
                    <button className="catalog-select" onClick={() => handleSelect(cat)}>
                      <span>{cat}</span>
                      {cat === currentCatalog && <span className="badge-active">Ativo</span>}
                    </button>
                    <div className="catalog-actions">
                      <button className="icon-btn" title="Renomear" onClick={() => {
                        setRenamingId(cat);
                        setRenameValue(cat);
                      }}><Edit2 size={14} /></button>
                      <button className="icon-btn danger" title="Excluir" onClick={() => handleDelete(cat)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="modal-create">
          <input
            ref={newNameInputRef}
            placeholder="Nome do novo curso (ex.: Medicina Unipac 2025)..."
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
          />
          <button
            className="btn-primary"
            onClick={handleCreate}
            disabled={creating}
          >
            <Plus size={16} />
            {creating ? 'Criando...' : 'Criar'}
          </button>
        </div>

        {error && <p className="modal-error">{error}</p>}
      </div>
    </div>
  );
}
