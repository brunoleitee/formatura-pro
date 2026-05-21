import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { CheckCircle2, CloudOff } from 'lucide-react';
import { CloudEventDashboard } from '../features/cloud/CloudEventDashboard';
import { CloudExplorer } from '../features/cloud/CloudExplorer';
import { CloudNavigationBar } from '../features/cloud/CloudNavigationBar';
import { CloudRecentCatalogs } from '../features/cloud/CloudRecentCatalogs';
import { CloudWorkflowPanel } from '../features/cloud/CloudWorkflowPanel';
import { catalogToDraft, draftToCatalog } from '../features/cloud/cloudCatalogStore';
import {
  canGoUp,
  createNavigationSnapshot,
  parentBreadcrumb,
  type CloudBreadcrumbItem,
  type CloudNavigationSnapshot,
} from '../features/cloud/cloudNavigationStore';
import { detectReferenceFolders } from '../features/cloud/detectReferenceFolders';
import type { CloudCatalog, CloudCatalogMode, CloudConnection, CloudEventDraft, CloudFolderInsight, CloudItem } from '../features/cloud/types';
import { cloudApi } from '../services/cloudApi';
import styles from './CloudView.module.css';

const rootBreadcrumb: CloudBreadcrumbItem[] = [{ id: 'root', name: 'Meu Drive' }];

function buildDraft(
  folder: CloudItem,
  references: string[] = [],
  totalFiles = 0,
  subfolderCount = 0,
): CloudEventDraft {
  return {
    name: folder.name,
    source: 'cloud',
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
  const [breadcrumb, setBreadcrumb] = useState<CloudBreadcrumbItem[]>(rootBreadcrumb);
  const [backStack, setBackStack] = useState<CloudNavigationSnapshot[]>([]);
  const [forwardStack, setForwardStack] = useState<CloudNavigationSnapshot[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<CloudItem | null>(null);
  const [draft, setDraft] = useState<CloudEventDraft | null>(null);
  const [recentCatalogs, setRecentCatalogs] = useState<CloudCatalog[]>([]);
  const [folderInsights, setFolderInsights] = useState<Record<string, CloudFolderInsight>>({});
  const [loading, setLoading] = useState(true);
  const [catalogsLoading, setCatalogsLoading] = useState(false);
  const [catalogSuccess, setCatalogSuccess] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [catalogProgress, setCatalogProgress] = useState<{ percent: number; label: string } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const connected = Boolean(connection?.connected);
  const currentFolderId = breadcrumb[breadcrumb.length - 1]?.id || 'root';
  const currentFolderName = breadcrumb[breadcrumb.length - 1]?.name || 'Meu Drive';
  const showFolderMetadata = breadcrumb.length > 1;

  const loadStatus = useCallback(async () => {
    const status = await cloudApi.getCloudStatus();
    const google = status.connections.find(item => item.provider === 'google_drive') || null;
    setConnection(google);
    return google;
  }, []);

  const loadRecentCatalogs = useCallback(async () => {
    setCatalogsLoading(true);
    try {
      const result = await cloudApi.listCloudCatalogs();
      setRecentCatalogs(result.catalogs || []);
    } finally {
      setCatalogsLoading(false);
    }
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
      await loadRecentCatalogs();
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
  }, [loadFolder, loadRecentCatalogs, loadStatus]);

  const selectedDraft = useMemo(() => {
    if (draft) return draft;
    if (!selectedFolder) return null;
    return buildDraft(selectedFolder);
  }, [draft, selectedFolder]);

  const restoreNavigation = useCallback((snapshot: CloudNavigationSnapshot) => {
    setBreadcrumb(snapshot.breadcrumb);
    setSelectedFolder(null);
    setDraft(null);
    void loadFolder(snapshot.currentFolderId);
  }, [loadFolder]);

  const handleOpenFolder = (folder: CloudItem) => {
    setBackStack(prev => [...prev, createNavigationSnapshot(breadcrumb)]);
    setForwardStack([]);
    setBreadcrumb(prev => [...prev, { id: folder.id, name: folder.name }]);
    setSelectedFolder(null);
    setDraft(null);
    void loadFolder(folder.id);
  };

  const handleBack = useCallback(() => {
    setBackStack(prev => {
      if (prev.length === 0) return prev;
      const nextBack = prev.slice(0, -1);
      const target = prev[prev.length - 1];
      setForwardStack(current => [...current, createNavigationSnapshot(breadcrumb)]);
      restoreNavigation(target);
      return nextBack;
    });
  }, [breadcrumb, restoreNavigation]);

  const handleForward = useCallback(() => {
    setForwardStack(prev => {
      if (prev.length === 0) return prev;
      const nextForward = prev.slice(0, -1);
      const target = prev[prev.length - 1];
      setBackStack(current => [...current, createNavigationSnapshot(breadcrumb)]);
      restoreNavigation(target);
      return nextForward;
    });
  }, [breadcrumb, restoreNavigation]);

  const handleUp = useCallback(() => {
    if (!canGoUp(breadcrumb)) return;
    const next = parentBreadcrumb(breadcrumb);
    setBackStack(prev => [...prev, createNavigationSnapshot(breadcrumb)]);
    setForwardStack([]);
    setBreadcrumb(next);
    setSelectedFolder(null);
    setDraft(null);
    void loadFolder(next[next.length - 1]?.id || 'root');
  }, [breadcrumb, loadFolder]);

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
    setBackStack(prev => [...prev, createNavigationSnapshot(breadcrumb)]);
    setForwardStack([]);
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
    if (!selectedDraft?.sourceFolderId) {
      setCatalogError('Selecione uma pasta do Google Drive antes de criar o catálogo.');
      return null;
    }
    setCreating(true);
    setCatalogError('');
    setCatalogProgress({ percent: 0, label: 'Preparando catálogo' });
    try {
      await new Promise(resolve => window.setTimeout(resolve, 180));
      setCatalogProgress({ percent: 25, label: 'Lendo estrutura da pasta' });
      await new Promise(resolve => window.setTimeout(resolve, 180));
      setCatalogProgress({ percent: 50, label: 'Contando fotos' });
      await new Promise(resolve => window.setTimeout(resolve, 180));
      setCatalogProgress({ percent: 75, label: 'Detectando referências' });
      const payload = {
        provider: selectedDraft.provider,
        folderId: selectedDraft.sourceFolderId,
        eventName: selectedDraft.name,
        references: selectedDraft.references,
        totalFiles: selectedDraft.totalFiles,
        mode: selectedDraft.mode,
      };
      console.log('[cloud-catalog] criando', payload);
      const result = await cloudApi.createCloudCatalog(selectedDraft);
      console.log('[cloud-catalog] criado', result);
      if (result.error && result.status !== 'draft') {
        throw new Error(result.error);
      }
      const isFallback = result.status === 'draft' && Boolean(result.error);
      const nextDraft = result.catalog || selectedDraft;
      const indexedDraft: CloudEventDraft = {
        ...nextDraft,
        source: 'cloud',
        id: nextDraft.id || result.catalogId || selectedDraft.sourceFolderId,
        status: nextDraft.status,
        createdAt: nextDraft.createdAt || new Date().toISOString(),
      };
      setCatalogProgress({ percent: 100, label: 'Catálogo criado' });
      await new Promise(resolve => window.setTimeout(resolve, 280));
      setDraft(indexedDraft);
      const optimisticCatalog = draftToCatalog(indexedDraft);
      if (optimisticCatalog) {
        setRecentCatalogs(prev => [
          optimisticCatalog,
          ...prev.filter(catalog => catalog.id !== optimisticCatalog.id),
        ].slice(0, 12));
      }
      setCatalogSuccess(isFallback ? 'Catálogo cloud criado localmente em modo draft' : 'Catálogo criado com sucesso');
      window.setTimeout(() => setCatalogSuccess(''), 3200);
      if (!isFallback) {
        await loadRecentCatalogs();
      }
      return indexedDraft;
    } catch (error: any) {
      setCatalogError(error?.message || 'Erro ao criar catálogo cloud. Tente novamente.');
      return null;
    } finally {
      setCreating(false);
      setCatalogProgress(null);
    }
  };

  const handleAnalyze = async () => {
    if (!selectedDraft?.id || !selectedDraft.status) return;
    setAnalyzing(true);
    try {
      await cloudApi.analyzeCloudCatalog(selectedDraft.id);
      setDraft(prev => prev ? { ...prev, status: 'processing' } : prev);
      await loadRecentCatalogs();
    } finally {
      setAnalyzing(false);
    }
  };

  const handleOpenRecentCatalog = async (catalog: CloudCatalog) => {
    try {
      const result = await cloudApi.getCloudCatalog(catalog.id);
      const nextCatalog = result.catalog || catalog;
      setSelectedFolder(null);
      setDraft(catalogToDraft(nextCatalog));
      await loadRecentCatalogs();
    } catch {
      setDraft(catalogToDraft(catalog));
    }
  };

  const handleCloudMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button === 3) {
      event.preventDefault();
      handleBack();
    }
    if (event.button === 4) {
      event.preventDefault();
      handleForward();
    }
  };

  return (
    <div className={styles.page} onMouseDown={handleCloudMouseDown}>
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
        <>
        <CloudRecentCatalogs
          catalogs={recentCatalogs}
          loading={catalogsLoading}
          onOpenCatalog={handleOpenRecentCatalog}
        />

        {catalogSuccess && (
          <div className={styles.successNotice}>
            <CheckCircle2 size={15} />
            {catalogSuccess}
          </div>
        )}

        {catalogError && (
          <div className={styles.errorNotice}>
            {catalogError}
          </div>
        )}

        <div className={styles.importHeader}>
          <span>Entrada/importação</span>
          <small>Use o explorer apenas para escolher novas pastas do Google Drive.</small>
        </div>

        <CloudNavigationBar
          currentFolderName={currentFolderName}
          cacheSize={selectedDraft?.cacheSize}
          loading={loading}
          canGoBack={backStack.length > 0}
          canGoForward={forwardStack.length > 0}
          canGoUp={canGoUp(breadcrumb)}
          onBack={handleBack}
          onForward={handleForward}
          onUp={handleUp}
          onRefresh={handleRefresh}
        />

        <div className={styles.mainGrid}>
          <CloudExplorer
            items={items}
            breadcrumb={breadcrumb}
            loading={loading}
            selectedFolderId={selectedFolder?.id}
            folderInsights={folderInsights}
            showFolderMetadata={showFolderMetadata}
            onOpenFolder={handleOpenFolder}
            onSelectFolder={handleSelectFolder}
            onGoToBreadcrumb={handleGoToBreadcrumb}
          />

          <aside className={styles.sideStack}>
            {selectedDraft?.id || selectedDraft?.status === 'indexed' || selectedDraft?.status === 'processing' ? (
              <CloudEventDashboard draft={selectedDraft} onAnalyze={handleAnalyze} />
            ) : selectedDraft ? (
              <CloudWorkflowPanel
                draft={selectedDraft}
                loading={preparing}
                creating={creating}
                progress={catalogProgress}
                analyzing={analyzing}
                catalogReady={Boolean(selectedDraft.id && selectedDraft.status !== 'draft')}
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
        </>
      )}
    </div>
  );
}
