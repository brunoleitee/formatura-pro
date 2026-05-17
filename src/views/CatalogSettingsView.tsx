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
      setFolders(f);
      setStats(s);
    } catch {
      setErr('Erro ao carregar configurações');
    } finally {
      setLoading(false);
    }
  }, [currentCatalog]);

  useEffect(() => { load(); }, [load]);

  const handleAddFolder = async () => {
    if (!currentCatalog) return;
    try {
      const res = await api.selectFolder();
      if (!res?.path) return;
      setAdding(true);
      const result = await catalogApi.addFolder(currentCatalog, res.path, true, false);
      if (result.success) {
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
            <div className={styles.leftHeader}>
              <button className={styles.addBtn} onClick={handleAddFolder} disabled={adding}>
                <Plus size={14} />
                {adding ? 'Adicionando...' : 'Adicionar pasta'}
              </button>
            </div>

            <div className={styles.dropZone} onClick={handleAddFolder}>
              <FolderOpen size={28} className={styles.dropIcon} />
              <span className={styles.dropText}>Arraste uma pasta para adicionar</span>
            </div>

            {err && <div className={styles.errorMsg}>{err}</div>}

            <div className={styles.folderList}>
              {folders.length > 0 ? (
                folders.map(f => (
                  <CatalogFolderCard
                    key={f.id}
                    folder={f}
                    onRemove={() => handleRemoveFolder(f)}
                    onScan={() => handleScanFolder(f)}
                  />
                ))
              ) : (
                <div className={styles.emptyFolders}>
                  Nenhuma pasta vinculada. Adicione uma pasta para começar.
                </div>
              )}
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
