import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudOff } from 'lucide-react';
import { CloudEventDashboard } from '../features/cloud/CloudEventDashboard';
import { CloudExplorer } from '../features/cloud/CloudExplorer';
import { CloudWorkflowPanel } from '../features/cloud/CloudWorkflowPanel';
import { detectReferenceFolders } from '../features/cloud/detectReferenceFolders';
import type { CloudCatalogMode, CloudConnection, CloudEventDraft, CloudFolderInsight, CloudItem } from '../features/cloud/types';
import { cloudApi } from '../services/cloudApi';
import styles from './CloudView.module.css';

type BreadcrumbItem = {
  id: string;
  name: string;
};

const rootBreadcrumb: BreadcrumbItem[] = [{ id: 'root', name: 'Meu Drive' }];

function buildDraft(
  folder: CloudItem,
  references: string[] = [],
  totalFiles = 0,
  subfolderCount = 0,
): CloudEventDraft {
  return {
    name: folder.name,
    provider: 'google_drive',
    sourceFolderId: folder.id,
    sourceFolderName: folder.name,
    references,
    totalFiles,
    subfolderCount,
    mode: 'face',
    status: 'draft',
  };
}

export default function CloudView() {
  const [connection, setConnection] = useState<CloudConnection | null>(null);
  const [items, setItems] = useState<CloudItem[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>(rootBreadcrumb);
  const [selectedFolder, setSelectedFolder] = useState<CloudItem | null>(null);
  const [draft, setDraft] = useState<CloudEventDraft | null>(null);
  const [folderInsights, setFolderInsights] = useState<Record<string, CloudFolderInsight>>({});
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
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
      const nextItems = result.items || [];
      setItems(nextItems);
      setFolderInsights(prev => ({
        ...prev,
        ...Object.fromEntries(
          nextItems
            .filter(item => item.isFolder)
            .map(item => [item.id, { ...prev[item.id], referenceDetected: detectReferenceFolders([item]).length > 0 }])
        ),
      }));
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
    setPreparing(true);
    try {
      const [subfoldersResult, indexedResult] = await Promise.all([
        cloudApi.listGoogleFolder(folder.id),
        cloudApi.getGoogleFolderSummary(folder.id)
          .catch(async () => {
            const indexed = await cloudApi.indexFolder(folder.id);
            return { photos: indexed.count ?? indexed.files?.length ?? 0, subfolders: 0 };
          }),
      ]);
      const subfolders = subfoldersResult.items || [];
      const references = detectReferenceFolders(subfolders).map(item => item.name);
      const totalFiles = indexedResult.photos ?? 0;
      const subfolderCount = indexedResult.subfolders ?? subfolders.length;
      setFolderInsights(prev => ({
        ...prev,
        [folder.id]: {
          photoCount: totalFiles,
          subfolderCount,
          referenceDetected: references.length > 0,
        },
        ...Object.fromEntries(
          subfolders
            .filter(item => item.isFolder)
            .map(item => [item.id, { ...prev[item.id], referenceDetected: detectReferenceFolders([item]).length > 0 }])
        ),
      }));
      setDraft(buildDraft(folder, references, totalFiles, subfolderCount));
    } catch {
      setDraft(buildDraft(folder));
    } finally {
      setPreparing(false);
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

  const handleChangeReferences = () => {
    if (!selectedDraft) return;
    const typed = window.prompt(
      'Informe as pastas de referência separadas por vírgula',
      selectedDraft.references.join(', '),
    );
    if (typed === null) return;
    const references = typed.split(',').map(item => item.trim()).filter(Boolean);
    setDraft({ ...selectedDraft, references });
  };

  const handleModeChange = (mode: CloudCatalogMode) => {
    if (!selectedDraft) return;
    setDraft({ ...selectedDraft, mode });
  };

  const handleCreateCatalog = async () => {
    if (!selectedDraft) return null;
    setCreating(true);
    try {
      const result = await cloudApi.createCloudCatalog(selectedDraft);
      const nextDraft = result.catalog || selectedDraft;
      const indexedDraft: CloudEventDraft = {
        ...nextDraft,
        id: nextDraft.id || result.catalogId || selectedDraft.sourceFolderId,
        status: nextDraft.status === 'draft' ? 'indexed' : nextDraft.status,
        createdAt: nextDraft.createdAt || new Date().toISOString(),
      };
      setDraft(indexedDraft);
      return indexedDraft;
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
            folderInsights={folderInsights}
            onOpenFolder={handleOpenFolder}
            onSelectFolder={handleSelectFolder}
            onGoToBreadcrumb={handleGoToBreadcrumb}
            onRefresh={handleRefresh}
          />

          <aside className={styles.sideStack}>
            {selectedDraft?.id || selectedDraft?.status === 'indexed' || selectedDraft?.status === 'processing' ? (
              <CloudEventDashboard draft={selectedDraft} onAnalyze={handleAnalyze} />
            ) : selectedDraft ? (
              <CloudWorkflowPanel
                draft={selectedDraft}
                loading={preparing}
                creating={creating}
                analyzing={analyzing}
                onModeChange={handleModeChange}
                onCreateCatalog={handleCreateCatalog}
                onChangeReferences={handleChangeReferences}
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
