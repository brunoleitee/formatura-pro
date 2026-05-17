import { useState, useEffect } from 'react';
import { FolderOpen, Plus, Info, CheckCircle2, Eye } from 'lucide-react';
import { api } from '../services/api';
import { useApp } from '../context/AppContext';
import type { CatalogSettingsResponse } from '../services/api';
import { CatalogFolderCard } from './catalog-settings/CatalogFolderCard';
import { CatalogQuickActions } from './catalog-settings/CatalogQuickActions';
import { CatalogStatusCards } from './catalog-settings/CatalogStatusCards';
import styles from './CatalogSettingsView.module.css';

export default function CatalogSettingsView() {
  const { currentCatalog } = useApp();
  const [settings, setSettings] = useState<CatalogSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentCatalog) return;
    setLoading(true);
    api.getCatalogSettings(currentCatalog)
      .then(setSettings)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [currentCatalog]);

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
        <div className={styles.loading}>Carregando configurações...</div>
      ) : (
        <div className={styles.body}>
          {/* ── LEFT PANEL ── */}
          <div className={styles.leftPanel}>
            <div className={styles.leftHeader}>
              <button className={styles.addBtn}>
                <Plus size={14} />
                Adicionar pasta
              </button>
            </div>

            <div className={styles.dropZone}>
              <FolderOpen size={28} className={styles.dropIcon} />
              <span className={styles.dropText}>Arraste uma pasta para adicionar</span>
            </div>

            <div className={styles.folderList}>
              {settings?.scan_paths && settings.scan_paths.length > 0 ? (
                settings.scan_paths.map((p, i) => (
                  <CatalogFolderCard key={i} path={p} />
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

            <CatalogQuickActions />
            <CatalogStatusCards />

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
