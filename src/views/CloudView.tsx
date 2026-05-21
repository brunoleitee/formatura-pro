import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudOff } from 'lucide-react';
import { CloudCatalogDashboard } from '../features/cloud/CloudCatalogDashboard';
import { CloudEventSetup } from '../features/cloud/CloudEventSetup';
import { CloudExplorer } from '../features/cloud/CloudExplorer';
import type { CloudConnection, CloudEventDraft, CloudItem } from '../features/cloud/types';
import { cloudApi } from '../services/cloudApi';
import styles from './CloudView.module.css';

type BreadcrumbItem = {
  id: string;
  name: string;
};

const rootBreadcrumb: BreadcrumbItem[] = [{ id: 'root', name: 'Meu Drive' }];

function buildDraft(folder: CloudItem, totalFiles?: number): CloudEventDraft {
  return {
    name: folder.name,
    provider: 'google_drive',
    sourceFolderId: folder.id,
    sourceFolderName: folder.name,
    totalFiles,
    status: 'draft',
  };
}

export default function CloudView() {
  const [connection, setConnection] = useState<CloudConnection | null>(null);
  const [items, setItems] = useState<CloudItem[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>(rootBreadcrumb);
  const [selectedFolder, setSelectedFolder] = useState<CloudItem | null>(null);
  const [draft, setDraft] = useState<CloudEventDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const connected = Boolean(connection?.connected);
  const currentFolderId = breadcrumb[breadcrumb.length - 1]?.id || 'root';

  const loadStatus = useCallback(async () => {
    const status = await cloudApi.getCloudStatus();
    const google = status.connections.find(item => item.provider === 'google_drive') || null;
    setConnection(google);
    return google;
  }, []);

  const loadFolder = useCallback(async (folderId: string) => {
    setLoading(true);
    try {
      const result = await cloudApi.listGoogleFolder(folderId);
      setItems(result.items || []);
    } catch (e) {
      console.error('Erro ao carregar pasta cloud:', e);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    async function boot() {
      const google = await loadStatus();
      if (!active) return;
      if (google?.connected) {
        await loadFolder('root');
      } else {
        setLoading(false);
      }
    }
    void boot();
    return () => {
      active = false;
    };
  }, [loadFolder, loadStatus]);

  const selectedDraft = useMemo(() => {
    if (draft) return draft;
    if (!selectedFolder) return null;
    return buildDraft(selectedFolder);
  }, [draft, selectedFolder]);

  const handleOpenFolder = (folder: CloudItem) => {
    setBreadcrumb(prev => [...prev, { id: folder.id, name: folder.name }]);
    setSelectedFolder(null);
    setDraft(null);
    void loadFolder(folder.id);
  };

  const handleSelectFolder = async (folder: CloudItem) => {
    setSelectedFolder(folder);
    setDraft(buildDraft(folder));
    try {
      const files = await cloudApi.getFiles(folder.id);
      setDraft(buildDraft(folder, files.count ?? files.files?.length ?? 0));
    } catch {
      setDraft(buildDraft(folder));
    }
  };

  const handleGoToBreadcrumb = (index: number) => {
    const next = breadcrumb.slice(0, index + 1);
    setBreadcrumb(next);
    setSelectedFolder(null);
    setDraft(null);
    void loadFolder(next[next.length - 1]?.id || 'root');
  };

  const handleRefresh = async () => {
    await loadStatus();
    if (connected) {
      await loadFolder(currentFolderId);
    }
  };

  const handleSelectReferences = () => {
    if (!selectedFolder || !selectedDraft) return;
    setDraft({
      ...selectedDraft,
      referencesFolderId: selectedFolder.id,
      referencesFolderName: selectedFolder.name,
    });
  };

  const handleCreateCatalog = async () => {
    if (!selectedDraft) return null;
    setCreating(true);
    try {
      const result = await cloudApi.createCloudCatalog(selectedDraft);
      const nextDraft = result.catalog || selectedDraft;
      setDraft({ ...nextDraft, status: nextDraft.status === 'draft' ? 'indexed' : nextDraft.status });
      return nextDraft;
    } finally {
      setCreating(false);
    }
  };

  const handleAnalyze = async () => {
    if (!selectedDraft) return;
    setAnalyzing(true);
    try {
      const catalog = selectedDraft.id ? selectedDraft : await handleCreateCatalog();
      const catalogId = catalog?.id || selectedDraft.sourceFolderId;
      await cloudApi.analyzeCloudCatalog(catalogId);
      setDraft(prev => prev ? { ...prev, id: catalogId, status: 'processing' } : prev);
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>Nuvem</h1>
          <p>Explore seu Google Drive e crie catálogos cloud</p>
        </div>
        <span className={styles.connectionPill} data-connected={connected}>
          {connected ? 'Google Drive conectado' : 'Google Drive desconectado'}
        </span>
      </header>

      {!connected ? (
        <section className={styles.disconnectedPanel}>
          <CloudOff size={28} />
          <h2>Conecte o Google Drive nas Configurações</h2>
          <p>Esta aba fica focada no uso diário: navegar, escolher evento, referências e fotos.</p>
        </section>
      ) : (
        <div className={styles.mainGrid}>
          <CloudExplorer
            items={items}
            breadcrumb={breadcrumb}
            loading={loading}
            selectedFolderId={selectedFolder?.id}
            onOpenFolder={handleOpenFolder}
            onSelectFolder={handleSelectFolder}
            onGoToBreadcrumb={handleGoToBreadcrumb}
            onRefresh={handleRefresh}
          />

          <aside className={styles.sideStack}>
            {selectedDraft?.id || selectedDraft?.status === 'indexed' || selectedDraft?.status === 'processing' ? (
              <CloudCatalogDashboard draft={selectedDraft} onAnalyze={handleAnalyze} />
            ) : selectedDraft ? (
              <CloudEventSetup
                draft={selectedDraft}
                creating={creating}
                analyzing={analyzing}
                onCreateCatalog={handleCreateCatalog}
                onSelectReferences={handleSelectReferences}
                onAnalyze={handleAnalyze}
              />
            ) : (
              <div className={styles.emptyPanel}>
                Selecione uma pasta de evento para preparar o catálogo cloud.
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
