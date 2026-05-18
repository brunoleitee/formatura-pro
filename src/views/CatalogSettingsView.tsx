import { useState, useEffect, useCallback, useRef } from 'react';
import { FolderOpen, Plus, Info, CheckCircle2, Eye, Loader, ScanFace, XCircle } from 'lucide-react';
import { api, catalogApi } from '../services/api';
import { useApp } from '../context/AppContext';
import type { CatalogFolder, CatalogFolderStats, ScanStatus } from '../services/api';
import { CatalogFolderCard } from './catalog-settings/CatalogFolderCard';
import { CatalogQuickActions } from './catalog-settings/CatalogQuickActions';
import { CatalogStatusCards } from './catalog-settings/CatalogStatusCards';
import styles from './CatalogSettingsView.module.css';

export default function CatalogSettingsView() {
  const { currentCatalog } = useApp();
  const [folders, setFolders] = useState<CatalogFolder[]>([]);
  const [stats, setStats] = useState<CatalogFolderStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [selectedFolderPath, setSelectedFolderPath] = useState('');
  const [includeSubfolders, setIncludeSubfolders] = useState(false);
  const [scanImmediately, setScanImmediately] = useState(true);
  const [err, setErr] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncStatus, setSyncStatus] = useState('');
  const [syncDone, setSyncDone] = useState(false);
  const syncPollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!currentCatalog) return;
    setLoading(true);
    setErr('');
    try {
      const [f, s] = await Promise.all([
        catalogApi.listFolders(currentCatalog),
        catalogApi.getFolderStats(currentCatalog),
      ]);
      console.log('[CatalogSettings] folders:', f.length, 'stats:', s);
      setFolders(f);
      setStats(s);
    } catch {
      setErr('Erro ao carregar configurações');
    } finally {
      setLoading(false);
    }
  }, [currentCatalog]);

  // Recarrega o catálogo selecionado quando a tela abre ou o catálogo muda.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const pickFolder = useCallback(async () => {
    const res = await api.selectFolder();
    if (!res?.path) return '';
    setSelectedFolderPath(res.path);
    return res.path;
  }, []);

  const handleTopAddFolder = async () => {
    if (!currentCatalog) return;
    try {
      await pickFolder();
    } catch {
      setErr('Erro ao selecionar pasta');
    }
  };

  // Poll scan status durante sincronização
  const startSyncPolling = useCallback(() => {
    setSyncing(true);
    setSyncDone(false);
    setSyncProgress(0);
    setSyncStatus('Iniciando sincronização...');
    let startedSeen = false;
    if (syncPollRef.current) clearInterval(syncPollRef.current);
    syncPollRef.current = window.setInterval(async () => {
      try {
        const st: ScanStatus = await api.getScanStatus();
        if (st.is_scanning) {
          startedSeen = true;
          const pct = st.total_files > 0 ? Math.min(100, Math.round((st.total_processadas / st.total_files) * 100)) : 0;
          setSyncProgress(pct);
          setSyncStatus(st.status_text || `Processando... ${st.total_processadas}/${st.total_files}`);
        } else if (startedSeen || st.total_processadas > 0) {
          // Scan terminou
          setSyncProgress(100);
          setSyncStatus('Sincronização concluída!');
          setSyncDone(true);
          if (syncPollRef.current) clearInterval(syncPollRef.current);
          syncPollRef.current = null;
          setTimeout(() => { setSyncing(false); setSyncDone(false); }, 3000);
          await load();
        } else {
          setSyncStatus('Aguardando início do scan...');
        }
      } catch { /* ignore */ }
    }, 800);
  }, [load]);

  // Ao montar: verificar se scan já está rodando e retomar polling
  useEffect(() => {
    let cancelled = false;
    const checkAndResume = async () => {
      try {
        const st: ScanStatus = await api.getScanStatus();
        if (cancelled) return;
        if (st.is_scanning) {
          startSyncPolling();
        }
      } catch { /* ignore */ }
    };
    checkAndResume();
    return () => { cancelled = true; };
  }, []);

  // Cleanup polling ao desmontar
  useEffect(() => {
    return () => {
      if (syncPollRef.current) clearInterval(syncPollRef.current);
    };
  }, []);

  const handleAddFolder = async () => {
    if (!currentCatalog) return;
    const shouldScan = scanImmediately;
    try {
      const path = selectedFolderPath || await pickFolder();
      if (!path) return;
      setAdding(true);
      const result = await catalogApi.addFolder(currentCatalog, path, includeSubfolders, shouldScan);
      if (result.success) {
        setSelectedFolderPath('');
        setIncludeSubfolders(false);
        setScanImmediately(true);
        if (shouldScan) {
          startSyncPolling();
        } else {
          await load();
        }
      } else {
        setErr(result.error || 'Erro ao adicionar pasta');
      }
    } catch {
      setErr('Erro ao selecionar pasta');
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveFolder = async (folder: CatalogFolder) => {
    if (!currentCatalog) return;
    const confirmed = window.confirm(
      `Remover "${folder.path}" do catálogo?\n\nAs fotos no computador não serão apagadas, mas serão removidas da visualização de fotos.`
    );
    if (!confirmed) return;
    try {
      const result = await catalogApi.removeFolder(currentCatalog, folder.id);
      if (result.success) {
        await load();
      } else {
        setErr('Erro ao remover pasta');
      }
    } catch {
      setErr('Erro ao remover pasta');
    }
  };

  const handleToggleFolder = async (folder: CatalogFolder) => {
    if (!currentCatalog) return;
    try {
      const result = await catalogApi.toggleFolder(currentCatalog, folder.id);
      if (result.success) {
        await load();
      } else {
        setErr('Erro ao alterar status da pasta');
      }
    } catch {
      setErr('Erro ao alterar status da pasta');
    }
  };

  const handleScanFolder = async (folder: CatalogFolder) => {
    if (!currentCatalog) return;
    try {
      await catalogApi.scanFolder(currentCatalog, folder.path, folder.includeSubfolders);
      startSyncPolling();
    } catch {
      setErr('Erro ao iniciar scan');
    }
  };

  const handleSync = async () => {
    if (!currentCatalog) return;
    try {
      const result = await catalogApi.syncCatalog(currentCatalog);
      if (result.success) {
        startSyncPolling();
      } else {
        setErr(result.error || 'Erro ao sincronizar');
      }
    } catch {
      setErr('Erro ao sincronizar');
    }
  };

  const handleScanAll = async () => {
    if (!currentCatalog) return;
    for (const f of folders) {
      try {
        await catalogApi.scanFolder(currentCatalog, f.path, f.includeSubfolders);
      } catch { /* continue */ }
    }
    startSyncPolling();
  };

  const handleClearSelection = () => {
    setSelectedFolderPath('');
    setIncludeSubfolders(false);
    setScanImmediately(true);
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.breadcrumb}>
          <span className={styles.breadcrumbItem}>Catálogo</span>
          <span className={styles.breadcrumbSep}>›</span>
          <span className={styles.breadcrumbItem}>{currentCatalog || '—'}</span>
          <span className={styles.breadcrumbSep}>›</span>
          <span className={styles.breadcrumbCurrent}>Configurações</span>
        </div>
      </div>

      {loading ? (
        <div className={styles.loading}><Loader size={18} className="spin" style={{ marginRight: 8 }} /> Carregando configurações...</div>
      ) : (
        <div className={styles.body}>
          {/* ── LEFT PANEL ── */}
          <div className={styles.leftPanel}>
            <div className={styles.leftHero}>
              <div>
                <h1 className={styles.pageTitle}>Pastas do catálogo</h1>
                <p className={styles.pageSubtitle}>Pastas atualmente vinculadas e sendo escaneadas.</p>
              </div>
              <button className={styles.addBtn} onClick={handleTopAddFolder} disabled={adding}>
                <Plus size={14} />
                {adding ? 'Adicionando...' : 'Adicionar pasta'}
              </button>
            </div>

            <div className={styles.folderTableCard}>
              <div className={styles.folderTableHead}>
                <span className={styles.folderTableBlank} />
                <span>Pasta</span>
                <span>Fotos</span>
                <span>Último scan</span>
                <span>Status</span>
                <span>Ações</span>
              </div>

              <div className={styles.folderTableBody}>
                {folders.length > 0 ? (
                  folders.map(f => (
                    <CatalogFolderCard
                      key={f.id}
                      folder={f}
                      onRemove={() => handleRemoveFolder(f)}
                      onScan={() => handleScanFolder(f)}
                      onToggle={() => handleToggleFolder(f)}
                    />
                  ))
                ) : (
                  <div className={styles.emptyFolders}>
                    Nenhuma pasta vinculada. Adicione uma pasta para começar.
                  </div>
                )}
              </div>

            </div>

            {/* ── SYNC PROGRESS BAR ── */}
            {syncing && (
              <div className={`${styles.syncBar} ${syncDone ? styles.syncBarDone : ''}`}>
                <div className={styles.syncBarHeader}>
                  <div className={styles.syncBarLeft}>
                    {syncDone ? (
                      <CheckCircle2 size={15} className={styles.syncBarIconDone} />
                    ) : (
                      <Loader size={15} className={`spin ${styles.syncBarIcon}`} />
                    )}
                    <span className={styles.syncBarTitle}>
                      {syncDone ? 'Sincronização concluída' : 'Sincronizando com o catálogo...'}
                    </span>
                  </div>
                  <div className={styles.syncBarRight}>
                    <span className={styles.syncBarPct}>{syncProgress}%</span>
                    <button className={styles.syncBarClose} onClick={() => { setSyncing(false); if (syncPollRef.current) clearInterval(syncPollRef.current); }}>
                      <XCircle size={14} />
                    </button>
                  </div>
                </div>
                <div className={styles.syncBarTrack}>
                  <div
                    className={`${styles.syncBarFill} ${syncDone ? styles.syncBarFillDone : ''}`}
                    style={{ width: `${syncProgress}%` }}
                  />
                </div>
                <div className={styles.syncBarStatus}>{syncStatus}</div>
              </div>
            )}

            {err && <div className={styles.errorMsg}>{err}</div>}

            <div className={styles.addSectionCard}>
              <div className={styles.addSectionHeader}>
                <div>
                  <h2 className={styles.addSectionTitle}>Adicionar pasta</h2>
                </div>
              </div>

              <div className={styles.folderPickerRow}>
                <div className={styles.folderPickerField}>
                  <FolderOpen size={16} className={styles.folderPickerIcon} />
                  <span className={selectedFolderPath ? styles.folderPickerValue : styles.folderPickerPlaceholder}>
                    {selectedFolderPath || 'Selecionar pasta...'}
                  </span>
                </div>
                <button className={styles.folderPickerBtn} onClick={handleTopAddFolder} type="button">
                  Selecionar
                </button>
              </div>

              <div className={styles.optionsGrid}>
                <button
                  className={`${styles.optionCard} ${scanImmediately ? styles.optionCardActive : ''}`}
                  type="button"
                  onClick={() => setScanImmediately(v => !v)}
                >
                  <span className={`${styles.checkboxBox} ${scanImmediately ? styles.checkboxBoxChecked : ''}`}>
                    {scanImmediately ? '✓' : ''}
                  </span>
                  <span className={styles.optionText}>
                    <span className={styles.optionTitle}>Escanear imediatamente</span>
                    <span className={styles.optionSubtitle}>Iniciar o scan assim que a pasta for adicionada</span>
                  </span>
                </button>

                <button
                  className={`${styles.optionCard} ${includeSubfolders ? styles.optionCardActive : ''}`}
                  type="button"
                  onClick={() => setIncludeSubfolders(v => !v)}
                >
                  <span className={`${styles.checkboxBox} ${includeSubfolders ? styles.checkboxBoxChecked : ''}`}>
                    {includeSubfolders ? '✓' : ''}
                  </span>
                  <span className={styles.optionText}>
                    <span className={styles.optionTitle}>Incluir subpastas</span>
                    <span className={styles.optionSubtitle}>Incluir todas as subpastas da pasta selecionada</span>
                  </span>
                </button>
              </div>

              <div className={styles.addSectionFooter}>
                <button className={styles.cancelBtn} onClick={handleClearSelection} type="button">
                  Cancelar
                </button>
                <button className={styles.confirmBtn} onClick={handleAddFolder} disabled={adding || !selectedFolderPath} type="button">
                  {adding ? 'Adicionando...' : 'Adicionar pasta'}
                </button>
              </div>
            </div>
          </div>

          {/* ── RIGHT PANEL ── */}
          <div className={styles.rightPanel}>
            <div className={styles.infoCard}>
              <div className={styles.infoCardHeader}>
                <Info size={14} />
                <span>Sobre</span>
              </div>
              <p className={styles.infoCardText}>
                Adicione novas pastas ao catálogo. O sistema irá escanear apenas imagens novas e fazer junção automática com fotos já reconhecidas.
              </p>
            </div>

            <CatalogQuickActions
              onScanAll={handleScanAll}
              onSync={handleSync}
            />
            <CatalogStatusCards stats={stats} />

            {!syncing && stats && stats.newPhotos === 0 && (
              <div className={styles.syncFooter}>
                <CheckCircle2 size={14} className={styles.syncIcon} />
                <span className={styles.syncText}>Catálogo sincronizado com sucesso</span>
              </div>
            )}
            {syncing && (
              <div className={`${styles.syncFooter} ${styles.syncFooterActive}`}>
                <Loader size={14} className={`spin ${styles.syncIconActive}`} />
                <span className={styles.syncTextActive}>Sincronizando...</span>
              </div>
            )}

            <button className={styles.viewNewBtn}>
              <Eye size={14} />
              Ver fotos novas
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
