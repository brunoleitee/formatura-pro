import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { CheckCircle2, CloudOff } from 'lucide-react';
import { CloudEventDashboard } from '../features/cloud/CloudEventDashboard';
import { CloudExplorer } from '../features/cloud/CloudExplorer';
import { CloudNavigationBar } from '../features/cloud/CloudNavigationBar';
import { CloudRecentCatalogs } from '../features/cloud/CloudRecentCatalogs';
import { CloudWorkflowPanel } from '../features/cloud/CloudWorkflowPanel';
import { CloudCatalogCreateModal } from '../features/cloud/CloudCatalogCreateModal';
import { CloudCatalogDeleteModal } from '../features/cloud/CloudCatalogDeleteModal';
import { catalogToDraft, draftToCatalog } from '../features/cloud/cloudCatalogStore';
import {
  canGoUp,
  createNavigationSnapshot,
  parentBreadcrumb,
  type CloudBreadcrumbItem,
  type CloudNavigationSnapshot,
} from '../features/cloud/cloudNavigationStore';
import { detectReferenceFolders } from '../features/cloud/detectReferenceFolders';
import type { CloudCatalog, CloudCatalogMode, CloudCatalogSession, CloudConnection, CloudEventDraft, CloudFolderInsight, CloudItem } from '../features/cloud/types';
import { cloudApi } from '../services/cloudApi';
import { api } from '../services/api';
import styles from './CloudView.module.css';

const rootBreadcrumb: CloudBreadcrumbItem[] = [{ id: 'root', name: 'Meu Drive' }];

type CloudMode = 'home' | 'explorer' | 'workspace';
type CloudDeleteScope = 'recent' | 'catalog_cache' | 'all';
type ExplorerSessionSnapshot = {
  currentFolderId: string;
  breadcrumb: CloudBreadcrumbItem[];
  backStack: CloudNavigationSnapshot[];
  forwardStack: CloudNavigationSnapshot[];
  selectedFolderId: string | null;
};

const EXPLORER_SESSION_KEY = 'formatura-pro-cloud-explorer-session';

function buildDefaultBreadcrumb(catalog: CloudCatalog): CloudBreadcrumbItem[] {
  return [
    rootBreadcrumb[0],
    { id: catalog.sourceFolderId, name: catalog.sourceFolderName || catalog.name },
  ];
}

function sessionToBreadcrumb(session?: CloudCatalogSession | null, fallback?: CloudCatalog | null): CloudBreadcrumbItem[] {
  if (session?.currentPathJson?.length) {
    return session.currentPathJson;
  }
  if (fallback) {
    return buildDefaultBreadcrumb(fallback);
  }
  return rootBreadcrumb;
}

function buildDraft(
  folder: CloudItem,
  sourceBreadcrumb: string[] = [],
  references: string[] = [],
  totalFiles = 0,
  totalSubfolders = 0,
): CloudEventDraft {
  return {
    name: folder.name,
    source: 'cloud',
    type: 'cloud',
    provider: 'google_drive',
    sourceFolderId: folder.id,
    sourceFolderName: folder.name,
    sourceBreadcrumb,
    references,
    totalFiles,
    subfolderCount: totalSubfolders,
    totalSubfolders,
    referencesCount: references.length,
    mode: 'face',
    status: 'draft',
  };
}

function readExplorerSession(): ExplorerSessionSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(EXPLORER_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ExplorerSessionSnapshot>;
    if (!parsed || typeof parsed.currentFolderId !== 'string') return null;
    return {
      currentFolderId: parsed.currentFolderId || 'root',
      breadcrumb: Array.isArray(parsed.breadcrumb) && parsed.breadcrumb.length
        ? parsed.breadcrumb.filter((item): item is CloudBreadcrumbItem => Boolean(item && item.id && item.name))
        : rootBreadcrumb,
      backStack: Array.isArray(parsed.backStack) ? parsed.backStack : [],
      forwardStack: Array.isArray(parsed.forwardStack) ? parsed.forwardStack : [],
      selectedFolderId: typeof parsed.selectedFolderId === 'string' ? parsed.selectedFolderId : null,
    };
  } catch {
    return null;
  }
}

function saveExplorerSession(snapshot: ExplorerSessionSnapshot) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(EXPLORER_SESSION_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignora falhas locais.
  }
}

export default function CloudView() {
  const [connection, setConnection] = useState<CloudConnection | null>(null);
  const [cloudMode, setCloudMode] = useState<CloudMode>('home');
  const [items, setItems] = useState<CloudItem[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<CloudBreadcrumbItem[]>(rootBreadcrumb);
  const [backStack, setBackStack] = useState<CloudNavigationSnapshot[]>([]);
  const [forwardStack, setForwardStack] = useState<CloudNavigationSnapshot[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<CloudItem | null>(null);
  const [draft, setDraft] = useState<CloudEventDraft | null>(null);
  const [recentCatalogs, setRecentCatalogs] = useState<CloudCatalog[]>([]);
  const [restorePromptCatalog, setRestorePromptCatalog] = useState<CloudCatalog | null>(null);
  const [workspaceCatalog, setWorkspaceCatalog] = useState<CloudCatalog | null>(null);
  const [workspaceSession, setWorkspaceSession] = useState<CloudCatalogSession | null>(null);
  const [folderInsights, setFolderInsights] = useState<Record<string, CloudFolderInsight>>({});
  const [loading, setLoading] = useState(true);
  const [catalogsLoading, setCatalogsLoading] = useState(false);
  const [catalogSuccess, setCatalogSuccess] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [catalogProgress, setCatalogProgress] = useState<{ percent: number; label: string } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [explorerError, setExplorerError] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [deleteCatalogOpen, setDeleteCatalogOpen] = useState(false);
  const [deleteCatalogScope, setDeleteCatalogScope] = useState<CloudDeleteScope>('recent');
  const [restoringCatalogId, setRestoringCatalogId] = useState<string | null>(null);
  const [catalogAiStatus, setCatalogAiStatus] = useState<CloudCatalog['aiStatus'] | null>(null);
  const saveSessionTimerRef = useRef<number | null>(null);
  const restoreGuardRef = useRef(false);
  const recentCatalogsRef = useRef<CloudCatalog[]>([]);

  const connected = Boolean(connection?.connected);
  const currentFolderId = breadcrumb[breadcrumb.length - 1]?.id || 'root';
  const currentFolderName = breadcrumb[breadcrumb.length - 1]?.name || 'Meu Drive';
  const explorerHasItems = items.length > 0;
  const workspaceBreadcrumb = workspaceSession?.currentPathJson?.length
    ? workspaceSession.currentPathJson
    : workspaceCatalog
      ? buildDefaultBreadcrumb(workspaceCatalog)
      : [];
  const workspaceTitle = workspaceCatalog?.name || 'Catálogo';

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
      const nextCatalogs = result.catalogs || [];
      recentCatalogsRef.current = nextCatalogs;
      setRecentCatalogs(nextCatalogs);
    } finally {
      setCatalogsLoading(false);
    }
  }, []);

  const loadFolder = useCallback(async (folderId: string) => {
    setLoading(true);
    setExplorerError('');
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
      if (result.error) {
        setExplorerError(result.error);
      }
      return nextItems;
    } catch (e) {
      console.error('Erro ao carregar pasta cloud:', e);
      setItems([]);
      setExplorerError('Não foi possível carregar o Google Drive. Tente novamente.');
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const loadExplorerFolder = useCallback(async (folderId: string) => {
    const nextItems = await loadFolder(folderId);
    return nextItems;
  }, [loadFolder]);

  const selectedDraft = useMemo(() => {
    if (draft) return draft;
    if (!selectedFolder) return null;
    return buildDraft(selectedFolder, [...breadcrumb.map(item => item.name), selectedFolder.name]);
  }, [breadcrumb, draft, selectedFolder]);

  const persistSession = useCallback(async () => {
    if (restoreGuardRef.current) return;
    if (!selectedDraft?.id) return;
    const session: CloudCatalogSession = {
      currentFolderId: breadcrumb[breadcrumb.length - 1]?.id || selectedDraft.sourceFolderId || 'root',
      currentPathJson: breadcrumb,
      selectedFolderId: selectedFolder?.id || '',
      selectedCatalogId: selectedDraft.id,
      scrollPosition: typeof window !== 'undefined' ? window.scrollY || 0 : 0,
      viewMode: 'cloud',
      backStack,
      forwardStack,
    };
    if (saveSessionTimerRef.current) {
      window.clearTimeout(saveSessionTimerRef.current);
    }
    saveSessionTimerRef.current = window.setTimeout(() => {
      void cloudApi.saveCloudCatalogSession(selectedDraft.id as string, session).catch(err => {
        console.error('Falha ao salvar sessão do catálogo cloud:', err);
      });
    }, 350);
  }, [backStack, breadcrumb, forwardStack, selectedDraft?.id, selectedDraft?.sourceFolderId, selectedFolder?.id]);

  const loadCatalogAiStatus = useCallback(async (catalogId: string) => {
    try {
      const status = await cloudApi.getCloudCatalogAiStatus(catalogId);
      setCatalogAiStatus(status);
      return status;
    } catch (error) {
      console.warn('Falha ao carregar status da IA do catálogo:', error);
      setCatalogAiStatus(null);
      return null;
    }
  }, []);

  const applyCatalogSession = useCallback(async (catalog: CloudCatalog, session?: CloudCatalogSession | null) => {
    restoreGuardRef.current = true;
    setRestoringCatalogId(catalog.id);
    try {
      setWorkspaceCatalog(catalog);
      setWorkspaceSession(session || null);
      setCatalogAiStatus(catalog.aiStatus || null);
      await api.updateSettings({
        cloud_last_catalog_id: catalog.id,
        cloud_restore_last_catalog: true,
      }).catch(() => {});
      setCloudMode('workspace');
    } finally {
      restoreGuardRef.current = false;
      setRestoringCatalogId(null);
    }
  }, []);

  const openCatalogProject = useCallback(async (catalogId: string) => {
    const result = await cloudApi.getCloudCatalog(catalogId);
    const catalog = result.catalog || recentCatalogsRef.current.find(item => item.id === catalogId);
    if (!catalog) {
      throw new Error('Catálogo cloud não encontrado');
    }
    setRestorePromptCatalog(null);
    await applyCatalogSession(catalog, result.session || null);
    if (catalog.status === 'draft') {
      setCatalogSuccess(`Catálogo "${catalog.name}" aberto em modo draft`);
    } else {
      setCatalogSuccess(`Catálogo "${catalog.name}" reaberto`);
    }
    window.setTimeout(() => setCatalogSuccess(''), 3000);
    return catalog;
  }, [applyCatalogSession]);

  const enterExplorer = useCallback(async () => {
    setRestorePromptCatalog(null);
    setCloudMode('explorer');
    await loadExplorerFolder('root');
    const session = readExplorerSession();
    if (session) {
      setBreadcrumb(session.breadcrumb?.length ? session.breadcrumb : rootBreadcrumb);
      setBackStack(session.backStack || []);
      setForwardStack(session.forwardStack || []);
      setSelectedFolder(null);
      setDraft(null);
      if (session.currentFolderId !== 'root') {
        await loadExplorerFolder(session.currentFolderId || 'root');
      }
      return;
    }
    setBreadcrumb(rootBreadcrumb);
    setBackStack([]);
    setForwardStack([]);
    setSelectedFolder(null);
    setDraft(null);
    await loadExplorerFolder('root');
  }, [loadExplorerFolder]);

  const closeWorkspace = useCallback(() => {
    setWorkspaceCatalog(null);
    setWorkspaceSession(null);
    setCatalogAiStatus(null);
    setCloudMode('home');
  }, []);

  const backToDrive = useCallback(async () => {
    setCloudMode('explorer');
    await loadExplorerFolder(currentFolderId || 'root');
  }, [currentFolderId, loadExplorerFolder]);

  useEffect(() => {
    if (saveSessionTimerRef.current) {
      window.clearTimeout(saveSessionTimerRef.current);
      saveSessionTimerRef.current = null;
    }
    if (selectedDraft?.id) {
      persistSession();
    }
    return () => {
      if (saveSessionTimerRef.current) {
        window.clearTimeout(saveSessionTimerRef.current);
        saveSessionTimerRef.current = null;
      }
      if (selectedDraft?.id && !restoreGuardRef.current) {
        void cloudApi.saveCloudCatalogSession(selectedDraft.id, {
          currentFolderId: breadcrumb[breadcrumb.length - 1]?.id || selectedDraft.sourceFolderId || 'root',
          currentPathJson: breadcrumb,
          selectedFolderId: selectedFolder?.id || '',
          selectedCatalogId: selectedDraft.id,
          scrollPosition: typeof window !== 'undefined' ? window.scrollY || 0 : 0,
          viewMode: 'cloud',
          backStack,
          forwardStack,
        }).catch(() => {});
      }
    };
  }, [backStack, breadcrumb, forwardStack, persistSession, selectedDraft?.id, selectedDraft?.sourceFolderId, selectedFolder?.id]);

  useEffect(() => {
    if (cloudMode !== 'explorer') return;
    saveExplorerSession({
      currentFolderId,
      breadcrumb,
      backStack,
      forwardStack,
      selectedFolderId: selectedFolder?.id || null,
    });
  }, [backStack, breadcrumb, cloudMode, currentFolderId, forwardStack, selectedFolder?.id]);

  useEffect(() => {
    let active = true;
    async function boot() {
      const google = await loadStatus();
      if (!active) return;
      await loadRecentCatalogs();
      const settings = await api.getSettings().catch(() => null);
      if (!active) return;
      const shouldRestoreLast = Boolean(settings && (settings as any).cloud_restore_last_catalog !== false);
      const lastCatalogId = settings && typeof (settings as any).cloud_last_catalog_id === 'string'
        ? (settings as any).cloud_last_catalog_id as string
        : '';
      if (google?.connected && shouldRestoreLast && lastCatalogId) {
        try {
          const result = await cloudApi.getCloudCatalog(lastCatalogId);
          if (!active) return;
          const promptCatalog = result.catalog || recentCatalogsRef.current.find(item => item.id === lastCatalogId);
          if (promptCatalog) {
            setRestorePromptCatalog(promptCatalog);
          }
        } catch (error) {
          console.warn('Falha ao carregar último catálogo cloud:', error);
        }
      }
      if (google?.connected) {
        await loadExplorerFolder('root');
        const explorerSession = readExplorerSession();
        if (explorerSession?.currentFolderId) {
          setBreadcrumb(explorerSession.breadcrumb?.length ? explorerSession.breadcrumb : rootBreadcrumb);
          setBackStack(explorerSession.backStack || []);
          setForwardStack(explorerSession.forwardStack || []);
          setSelectedFolder(null);
          setDraft(null);
          if (explorerSession.currentFolderId !== 'root') {
            await loadExplorerFolder(explorerSession.currentFolderId || 'root');
          }
        }
        if (active) {
          setCloudMode('home');
        }
      } else {
        setLoading(false);
      }
      if (active) {
        setLoading(false);
      }
    }
    void boot();
    return () => {
      active = false;
    };
  }, [loadExplorerFolder, loadRecentCatalogs, loadStatus]);

  const restoreNavigation = useCallback((snapshot: CloudNavigationSnapshot) => {
    setBreadcrumb(snapshot.breadcrumb);
    setSelectedFolder(null);
    setDraft(null);
    void loadExplorerFolder(snapshot.currentFolderId);
  }, [loadExplorerFolder]);

  const handleOpenFolder = (folder: CloudItem) => {
    setBackStack(prev => [...prev, createNavigationSnapshot(breadcrumb)]);
    setForwardStack([]);
    setBreadcrumb(prev => [...prev, { id: folder.id, name: folder.name }]);
    setSelectedFolder(null);
    setDraft(null);
    void loadExplorerFolder(folder.id);
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
    void loadExplorerFolder(next[next.length - 1]?.id || 'root');
  }, [breadcrumb, loadExplorerFolder]);

  const handleSelectFolder = async (folder: CloudItem) => {
    setSelectedFolder(folder);
    const sourceBreadcrumb = [...breadcrumb.map(item => item.name), folder.name];
    setDraft(buildDraft(folder, sourceBreadcrumb));
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
      setDraft(buildDraft(folder, sourceBreadcrumb, references, totalFiles, subfolderCount));
    } catch {
      setDraft(buildDraft(folder, sourceBreadcrumb));
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
    void loadExplorerFolder(next[next.length - 1]?.id || 'root');
  };

  const handleRefresh = async () => {
    setExplorerError('');
    await loadStatus();
    if (connected) {
      await loadExplorerFolder(currentFolderId);
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

  const parentFolderName = useMemo(() => {
    if (breadcrumb.length <= 1) return null;
    const current = breadcrumb[breadcrumb.length - 1]?.name;
    return current && current !== 'Meu Drive' ? current : null;
  }, [breadcrumb]);

  const handleOpenCreateModal = useCallback(() => {
    setShowCreateModal(true);
  }, []);

  const handleCreateCatalog = async (name?: string) => {
    if (!selectedDraft?.sourceFolderId) {
      setCatalogError('Selecione uma pasta do Google Drive antes de criar o catálogo.');
      return null;
    }
    setShowCreateModal(false);
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
      const catalogName = name || selectedDraft.name;
      const catalogDraft = name ? { ...selectedDraft, name: catalogName } : selectedDraft;
      const payload = {
        provider: catalogDraft.provider,
        folderId: catalogDraft.sourceFolderId,
        eventName: catalogDraft.name,
        references: catalogDraft.references,
        totalFiles: catalogDraft.totalFiles,
        mode: catalogDraft.mode,
      };
      console.log('[cloud-catalog] criando', payload);
      const result = await cloudApi.createCloudCatalog(catalogDraft);
      console.log('[cloud-catalog] criado', result);
      if (result.error && result.status !== 'draft') {
        throw new Error(result.error);
      }
      const isFallback = result.status === 'draft' && Boolean(result.error);
      const nextDraft = result.catalog || catalogDraft;
      const indexedDraft: CloudEventDraft = {
        ...nextDraft,
        source: 'cloud',
        id: nextDraft.id || result.catalogId || catalogDraft.sourceFolderId,
        status: nextDraft.status,
        createdAt: nextDraft.createdAt || new Date().toISOString(),
      };
      const catalogId = indexedDraft.id || result.catalogId || catalogDraft.sourceFolderId;
      setCatalogProgress({ percent: 100, label: 'Catálogo criado' });
      await new Promise(resolve => window.setTimeout(resolve, 280));
      setDraft(indexedDraft);
      setRestorePromptCatalog(null);
      const optimisticCatalog = draftToCatalog(indexedDraft);
      if (optimisticCatalog) {
        setRecentCatalogs(prev => [
          optimisticCatalog,
          ...prev.filter(catalog => catalog.id !== optimisticCatalog.id),
        ].slice(0, 12));
      }
      await api.updateSettings({
        cloud_last_catalog_id: catalogId,
        cloud_restore_last_catalog: true,
      }).catch(() => {});
      await loadCatalogAiStatus(catalogId);
      const workspaceCatalog = (result.catalog as CloudCatalog | null) || draftToCatalog(indexedDraft);
      setWorkspaceCatalog(workspaceCatalog);
      setWorkspaceSession(null);
      setCloudMode('workspace');
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
      await openCatalogProject(catalog.id);
      await loadRecentCatalogs();
    } catch {
      setRestorePromptCatalog(null);
      await applyCatalogSession(catalog, null);
    }
  };

  const handleOpenExistingCatalog = useCallback(async () => {
    const useFolder = window.confirm('Clique em OK para selecionar a pasta do evento. Cancelar para escolher metadata.json ou evento.fpdb.');
    const picked = useFolder ? await api.selectFolder().catch(() => null) : await api.selectFile().catch(() => null);
    if (!picked?.path) return;
    setCatalogError('');
    setRestorePromptCatalog(null);
    try {
      const result = await cloudApi.openExistingCloudCatalog(picked.path);
      await applyCatalogSession(result.catalog, result.session || null);
      setRecentCatalogs(prev => [
        result.catalog,
        ...prev.filter(item => item.id !== result.catalog.id),
      ].slice(0, 12));
      await loadRecentCatalogs();
      await api.updateSettings({
        cloud_last_catalog_id: result.catalog.id,
        cloud_restore_last_catalog: true,
      }).catch(() => {});
      setCatalogSuccess(`Catálogo "${result.catalog.name}" aberto com sucesso`);
      window.setTimeout(() => setCatalogSuccess(''), 3000);
    } catch (error: any) {
      setCatalogError(error?.message || 'Não foi possível abrir o catálogo existente.');
    }
  }, [applyCatalogSession, loadRecentCatalogs]);

  const handleProcessCatalogAi = useCallback(async () => {
    if (!workspaceCatalog?.id) {
      setCatalogError('Abra um catálogo cloud antes de processar a IA.');
      return;
    }
    setCatalogError('');
    try {
      const result = await cloudApi.processCloudCatalogAi(workspaceCatalog.id, { limit: 12, recursive: true, force: false });
      await loadCatalogAiStatus(workspaceCatalog.id);
      setCatalogSuccess(
        result.processed
          ? `IA processada no catálogo (${result.processed} face(s) novas)`
          : 'Nenhuma face nova encontrada para processar'
      );
      window.setTimeout(() => setCatalogSuccess(''), 3000);
    } catch (error: any) {
      setCatalogError(error?.message || 'Falha ao processar a IA do catálogo.');
    }
  }, [loadCatalogAiStatus, workspaceCatalog?.id]);

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
        {cloudMode === 'home' && (
          <>
            {restorePromptCatalog && (
              <section className={styles.restorePrompt}>
                <div>
                  <span>Reabrir último catálogo?</span>
                  <strong>{restorePromptCatalog.name}</strong>
                  <small>{restorePromptCatalog.sourceFolderName || restorePromptCatalog.sourceFolderId}</small>
                </div>
                <div className={styles.restoreActions}>
                  <button type="button" className={styles.primaryButton} onClick={() => void openCatalogProject(restorePromptCatalog.id)}>
                    Reabrir
                  </button>
                  <button type="button" className={styles.secondaryButton} onClick={() => {
                    setRestorePromptCatalog(null);
                    setCloudMode('explorer');
                  }}>
                    Ir para Explorer
                  </button>
                </div>
              </section>
            )}

            <section className={styles.homeActions}>
              <button type="button" className={styles.primaryButton} onClick={() => {
                setRestorePromptCatalog(null);
                void enterExplorer();
              }}>
                Navegar no Google Drive
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => setCloudMode('home')}>
                Catálogos
              </button>
            </section>

            <CloudRecentCatalogs
              catalogs={recentCatalogs}
              loading={catalogsLoading || restoringCatalogId !== null}
              onOpenCatalog={handleOpenRecentCatalog}
              onOpenExistingCatalog={handleOpenExistingCatalog}
            />
          </>
        )}

        {cloudMode === 'explorer' && (
          <>
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

            <div className={styles.explorerModeBar}>
              <button type="button" className={styles.ghostButton} onClick={() => setCloudMode('explorer')}>
                ☁ Explorer
              </button>
              <button type="button" className={styles.ghostButton} onClick={() => setCloudMode('home')}>
                📂 Catálogos
              </button>
              <button type="button" className={styles.primaryButton} onClick={() => void backToDrive()}>
                ↩ Voltar ao Drive
              </button>
            </div>

            {!loading && !explorerHasItems && (
              <div className={styles.reloadNotice}>
                <span>Não foi possível carregar itens deste nível.</span>
                <button type="button" className={styles.secondaryButton} onClick={() => void loadExplorerFolder('root')}>
                  Recarregar Google Drive
                </button>
              </div>
            )}

            {explorerError && (
              <div className={styles.reloadNotice}>
                <span>{explorerError}</span>
                <button type="button" className={styles.secondaryButton} onClick={() => void loadExplorerFolder(currentFolderId || 'root')}>
                  Tentar novamente
                </button>
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
                onOpenFolder={handleOpenFolder}
                onSelectFolder={handleSelectFolder}
                onGoToBreadcrumb={handleGoToBreadcrumb}
              />

              <aside className={styles.sideStack}>
                {selectedDraft?.id || selectedDraft?.status === 'indexed' || selectedDraft?.status === 'processing' ? (
                  <CloudEventDashboard
                    draft={selectedDraft}
                    aiStatus={catalogAiStatus}
                    onProcessAi={handleProcessCatalogAi}
                    onOpenCatalogRoot={async path => {
                      if (!path) return;
                      await api.openFolder(path);
                    }}
                    onOpenCatalogFolder={async path => {
                      if (!path) return;
                      await api.openFolder(path);
                    }}
                    onReopenLastState={async () => {
                      if (!selectedDraft?.id) return;
                      const session = await cloudApi.getCloudCatalogSession(selectedDraft.id).catch(() => null);
                      const currentCatalog = draftToCatalog(selectedDraft);
                      if (!currentCatalog) return;
                      setWorkspaceCatalog(currentCatalog);
                      setWorkspaceSession(session?.session || null);
                      setCloudMode('workspace');
                      await loadCatalogAiStatus(selectedDraft.id);
                    }}
                  />
                ) : selectedDraft ? (
                  <CloudWorkflowPanel
                    draft={selectedDraft}
                    loading={preparing}
                    creating={creating}
                    progress={catalogProgress}
                    analyzing={analyzing}
                    catalogReady={Boolean(selectedDraft.id && selectedDraft.status !== 'draft')}
                    onModeChange={handleModeChange}
                    onCreateCatalog={handleOpenCreateModal}
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

            {showCreateModal && selectedDraft && (
              <CloudCatalogCreateModal
                draft={selectedDraft}
                parentFolderName={parentFolderName || undefined}
                creating={creating}
                onConfirm={handleCreateCatalog}
                onCancel={() => setShowCreateModal(false)}
              />
            )}
          </>
        )}

        {cloudMode === 'workspace' && workspaceCatalog && (
          <>
            <div className={styles.workspaceToolbar}>
              <button type="button" className={styles.ghostButton} onClick={() => void backToDrive()}>
                ← Voltar ao Drive
              </button>
              <button type="button" className={styles.ghostButton} onClick={() => setCloudMode('explorer')}>
                📂 Explorer
              </button>
              <button type="button" className={styles.ghostButton} onClick={() => setCloudMode('home')}>
                ☁ Catálogos
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => closeWorkspace()}>
                ✕ Fechar catálogo
              </button>
              <button type="button" className={styles.dangerButton} onClick={() => {
                setDeleteCatalogScope('recent');
                setDeleteCatalogOpen(true);
              }}>
                🗑 Excluir catálogo
              </button>
            </div>

            <div className={styles.workspaceBreadcrumb}>
              <span>☁ Nuvem</span>
              <span>›</span>
              <button type="button" onClick={() => setCloudMode('home')}>Catálogos</button>
              <span>›</span>
              <strong title={workspaceCatalog.name}>{workspaceCatalog.name}</strong>
            </div>

            <div className={styles.mainGrid}>
              <div className={styles.workspacePanel}>
                <div className={styles.importHeader}>
                  <span>Workspace do catálogo</span>
                  <small>Persistência, IA e revisão por evento.</small>
                </div>
                <div className={styles.pathStack}>
                  <div className={styles.pathBlock}>
                    <span>Pasta atual</span>
                    <strong title={workspaceSession?.currentPathJson?.map(i => i.name).join(' > ') || workspaceCatalog.sourceFolderName || workspaceCatalog.name}>
                      {workspaceSession?.currentPathJson?.map(i => i.name).join(' > ') || workspaceCatalog.sourceFolderName || workspaceCatalog.name}
                    </strong>
                  </div>
                  <div className={styles.pathBlock}>
                    <span>Status</span>
                    <strong>{workspaceCatalog.status === 'indexed' ? 'Indexado' : workspaceCatalog.status}</strong>
                  </div>
                </div>
                <p className={styles.mutedLine}>
                  Catálogo salvo em: {workspaceCatalog.catalogPath || 'indisponível'}
                </p>
              </div>

              <aside className={styles.sideStack}>
                <CloudEventDashboard
                  draft={catalogToDraft(workspaceCatalog)}
                  aiStatus={catalogAiStatus}
                  onProcessAi={handleProcessCatalogAi}
                  onOpenCatalogRoot={async path => {
                    if (!path) return;
                    await api.openFolder(path);
                  }}
                  onOpenCatalogFolder={async path => {
                    if (!path) return;
                    await api.openFolder(path);
                  }}
                  onReopenLastState={async () => {
                    const session = await cloudApi.getCloudCatalogSession(workspaceCatalog.id).catch(() => null);
                    setWorkspaceSession(session?.session || null);
                    await loadCatalogAiStatus(workspaceCatalog.id);
                  }}
                />
              </aside>
            </div>
          </>
        )}

        {deleteCatalogOpen && workspaceCatalog && (
          <CloudCatalogDeleteModal
            catalogName={workspaceCatalog.name}
            scope={deleteCatalogScope}
            onScopeChange={setDeleteCatalogScope}
            onCancel={() => setDeleteCatalogOpen(false)}
            onConfirm={async () => {
              const scope = deleteCatalogScope;
              setDeleteCatalogOpen(false);
              try {
                await cloudApi.deleteCloudCatalog(workspaceCatalog.id, scope);
                setRecentCatalogs(prev => prev.filter(item => item.id !== workspaceCatalog.id));
                recentCatalogsRef.current = recentCatalogsRef.current.filter(item => item.id !== workspaceCatalog.id);
                closeWorkspace();
                await loadRecentCatalogs();
              } catch (error: any) {
                setCatalogError(error?.message || 'Não foi possível excluir o catálogo.');
              }
            }}
          />
        )}
        </>
      )}
    </div>
  );
}
