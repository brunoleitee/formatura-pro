import { useState, useEffect, useCallback } from 'react';
import { FolderOpen, Plus, Info, CheckCircle2, Eye, Loader } from 'lucide-react';
import { api, catalogApi } from '../services/api';
import { useApp } from '../context/AppContext';
import type { CatalogFolder, CatalogFolderStats } from '../services/api';
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

  const handleAddFolder = async () => {
    if (!currentCatalog) return;
    try {
      const path = selectedFolderPath || await pickFolder();
      if (!path) return;
      setAdding(true);
      const result = await catalogApi.addFolder(currentCatalog, path, includeSubfolders, scanImmediately);
      if (result.success) {
        setSelectedFolderPath('');
        setIncludeSubfolders(false);
        setScanImmediately(true);
        await load();
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
      `Remover "${folder.path}" do catálogo?\n\nAs fotos no computador não serão apagadas.`
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

  const handleScanFolder = async (folder: CatalogFolder) => {
    if (!currentCatalog) return;
    try {
      await catalogApi.scanFolder(currentCatalog, folder.path, folder.includeSubfolders);
    } catch {
      setErr('Erro ao iniciar scan');
    }
  };

  const handleSync = async () => {
    if (!currentCatalog) return;
    try {
      const result = await catalogApi.syncCatalog(currentCatalog);
      if (!result.success) setErr(result.error || 'Erro ao sincronizar');
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
                      onEdit={() => {}}
                    />
                  ))
                ) : (
                  <div className={styles.emptyFolders}>
                    Nenhuma pasta vinculada. Adicione uma pasta para começar.
                  </div>
                )}
              </div>

              <div className={styles.dropZone} onClick={handleTopAddFolder}>
                <FolderOpen size={26} className={styles.dropIcon} />
                <span className={styles.dropText}>Arraste uma pasta para adicionar</span>
                <span className={styles.dropSubText}>ou clique no botão acima</span>
              </div>
            </div>

            {err && <div className={styles.errorMsg}>{err}</div>}

            <div className={styles.addSectionCard}>
              <div className={styles.addSectionHeader}>
                <div>
                  <h2 className={styles.addSectionTitle}>Adicionar nova pasta ao catálogo</h2>
                  <p className={styles.addSectionSubtitle}>
                    Selecione uma pasta no seu computador para adicionar ao catálogo.
                  </p>
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

            <div className={styles.syncFooter}>
              <CheckCircle2 size={14} className={styles.syncIcon} />
              <span className={styles.syncText}>Catálogo sincronizado com sucesso</span>
            </div>

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
