import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { CheckCircle2, CloudOff, RefreshCw, FolderOpen, FolderTree } from 'lucide-react';
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
import { api, type Photo } from '../services/api';
import { useCatalogPhotos } from '../hooks/useCatalogPhotos';
import { usePhotoFilters } from '../hooks/usePhotoFilters';
import { usePhotoSelection } from '../hooks/usePhotoSelection';
import { usePhotoViewer } from '../hooks/usePhotoViewer';
import { VirtualizedPhotoGrid } from '../components/photos/VirtualizedPhotoGrid';
import { ZoomControl } from '../components/photos/ZoomControl';
import { PhotoFilters } from '../components/photos/PhotoFilters';
import PhotoBulkActionsBar from '../components/photos/PhotoBulkActionsBar';
import { PhotoViewerModal } from '../components/photos/PhotoViewerModal';
import { PhotoDetailPanel } from '../components/photos/PhotoDetailPanel';
import { useApp } from '../context/AppContext';
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
  eventRoot?: { id: string; name: string },
  referencesFolderIds: string[] = [],
): CloudEventDraft {
  return {
    name: folder.name,
    source: 'cloud',
    type: 'cloud',
    provider: 'google_drive',
    sourceFolderId: folder.id,
    sourceFolderName: folder.name,
    eventRootFolderId: eventRoot?.id,
    eventRootFolderName: eventRoot?.name,
    referencesFolderIds,
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
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
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
  const fetchedSummariesRef = useRef<Set<string>>(new Set());
  
  const { setCatalog, currentCatalog, catalogSubfolder } = useApp();
  
  // Workspace hooks & states
  const [hideDiscarded, setHideDiscarded] = useState(false);
  const [zoom, setZoom] = useState(60);
  const size = useMemo(() => 100 + (zoom / 100) * (300 - 100), [zoom]);
  const {
    photos,
    loading: photosLoading,
    loadingMore: photosLoadingMore,
    hasMore: photosHasMore,
    loadPhotos,
    loadMore: loadMorePhotos,
    discardPhoto,
    restorePhoto,
  } = useCatalogPhotos();
  
  const { filteredPhotos, filter, setFilter } = usePhotoFilters(
    photos,
    currentCatalog,
    catalogSubfolder,
    hideDiscarded
  );
  
  const { selectedPaths, toggleSelection, clearSelection } = usePhotoSelection(filteredPhotos);
  const { viewerPhoto, setViewerPhoto } = usePhotoViewer(filteredPhotos);
  const [detailsPhoto, setDetailsPhoto] = useState<Photo | null>(null);
  
  const selectionCountRef = useRef(0);
  useEffect(() => {
    selectionCountRef.current = selectedPaths.size;
  }, [selectedPaths.size]);
  
  const getSelectionCount = useCallback(() => selectionCountRef.current, []);
  const gridScrollRef = useRef<HTMLDivElement | null>(null);

  const handleDiscardSelected = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    const paths = Array.from(selectedPaths);
    paths.forEach(p => discardPhoto(p));
    clearSelection();
    try {
      await api.bulkDiscardPhotos(currentCatalog, paths);
      loadPhotos();
    } catch (e) {
      console.error(e);
      loadPhotos();
    }
  }, [selectedPaths, currentCatalog, discardPhoto, clearSelection, loadPhotos]);

  const handleRestoreSelected = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    const paths = Array.from(selectedPaths);
    paths.forEach(p => restorePhoto(p));
    clearSelection();
    try {
      await api.bulkRestorePhotos(currentCatalog, paths);
      loadPhotos();
    } catch (e) {
      console.error(e);
      loadPhotos();
    }
  }, [selectedPaths, currentCatalog, restorePhoto, clearSelection, loadPhotos]);

  const handleRemoveIdentificationSelected = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    const paths = Array.from(selectedPaths);
    clearSelection();
    try {
      await api.bulkRemoveIdentification(currentCatalog, paths);
      loadPhotos();
    } catch (e) {
      console.error(e);
      loadPhotos();
    }
  }, [selectedPaths, currentCatalog, clearSelection, loadPhotos]);

  useEffect(() => {
    if (cloudMode === 'workspace' && workspaceCatalog) {
      if (currentCatalog !== workspaceCatalog.name) {
        void setCatalog(workspaceCatalog.name);
      }
    }
  }, [cloudMode, workspaceCatalog, currentCatalog, setCatalog]);
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
      setFolderInsights(prev => {
        const nextInsights = { ...prev };
        for (const catalog of nextCatalogs) {
          if (catalog.sourceFolderId) {
            nextInsights[catalog.sourceFolderId] = {
              ...prev[catalog.sourceFolderId],
              photoCount: catalog.totalFiles,
              subfolderCount: catalog.totalSubfolders ?? catalog.subfolderCount ?? 0,
              referenceDetected: (catalog.referencesCount ?? 0) > 0 || (catalog.references && catalog.references.length > 0) || false,
              referencesCount: catalog.referencesCount ?? catalog.references?.length ?? 0,
            };
          }
        }
        return nextInsights;
      });
    } finally {
      setCatalogsLoading(false);
    }
  }, []);

  const loadFolder = useCallback(async (folderId: string) => {
    setLoading(true);
    setExplorerError('');
    try {
      const result = await cloudApi.listGoogleFolder(folderId, undefined, 200);
      const nextItems = result.items || [];
      setItems(nextItems);
      setNextPageToken(result.nextPageToken);
      setFolderInsights(prev => {
        const nextInsights = { ...prev };
        nextInsights[folderId] = {
          ...prev[folderId],
          photoCount: result.photos,
          subfolderCount: result.subfolders,
        };
        for (const item of nextItems) {
          if (item.isFolder) {
            nextInsights[item.id] = {
              ...prev[item.id],
              photoCount: item.photoCount ?? prev[item.id]?.photoCount,
              subfolderCount: item.subfolderCount ?? prev[item.id]?.subfolderCount,
              referencesCount: item.referencesCount ?? prev[item.id]?.referencesCount,
              referenceDetected: item.referenceDetected ?? detectReferenceFolders([item]).length > 0 ?? prev[item.id]?.referenceDetected,
            };
          }
        }
        return nextInsights;
      });
      if (result.error) {
        setExplorerError(result.error);
      }
      return nextItems;
    } catch (e) {
      console.error('Erro ao carregar pasta cloud:', e);
      setItems([]);
      setNextPageToken(undefined);
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

  const handleLoadMoreBackend = useCallback(async () => {
    if (loadingMore || !nextPageToken) return;
    setLoadingMore(true);
    try {
      const result = await cloudApi.listGoogleFolder(currentFolderId, nextPageToken, 200);
      const nextItems = result.items || [];
      setItems(prev => {
        const existingIds = new Set(prev.map(item => item.id));
        const filteredNew = nextItems.filter(item => !existingIds.has(item.id));
        return [...prev, ...filteredNew];
      });
      setNextPageToken(result.nextPageToken);
      setFolderInsights(prev => {
        const nextInsights = { ...prev };
        nextInsights[currentFolderId] = {
          ...prev[currentFolderId],
          photoCount: (prev[currentFolderId]?.photoCount ?? 0) + (result.photos ?? 0),
          subfolderCount: (prev[currentFolderId]?.subfolderCount ?? 0) + (result.subfolders ?? 0),
        };
        for (const item of nextItems) {
          if (item.isFolder) {
            nextInsights[item.id] = {
              ...prev[item.id],
              photoCount: item.photoCount ?? prev[item.id]?.photoCount,
              subfolderCount: item.subfolderCount ?? prev[item.id]?.subfolderCount,
              referencesCount: item.referencesCount ?? prev[item.id]?.referencesCount,
              referenceDetected: item.referenceDetected ?? detectReferenceFolders([item]).length > 0 ?? prev[item.id]?.referenceDetected,
            };
          }
        }
        return nextInsights;
      });
      if (result.error) {
        setExplorerError(result.error);
      }
    } catch (e) {
      console.error('Erro ao carregar mais itens do Drive:', e);
    } finally {
      setLoadingMore(false);
    }
  }, [currentFolderId, nextPageToken, loadingMore]);

  const prepareFolderDraft = useCallback(async (
    folder: CloudItem,
    folderBreadcrumb: CloudBreadcrumbItem[],
    folderItems: CloudItem[] = [],
  ) => {
    const directPhotos = folderItems.filter(item => item.isImage || /^image\//.test(item.mimeType));
    const directFolders = folderItems.filter(item => item.isFolder || item.mimeType === 'application/vnd.google-apps.folder');
    const sourceBreadcrumb = folderBreadcrumb.map(item => item.name);
    const referenceMap = new Map<string, CloudItem>();
    let eventRoot: CloudBreadcrumbItem | null = null;

    const collectReferences = (scopeItems: CloudItem[], owner?: CloudBreadcrumbItem) => {
      const refs = detectReferenceFolders(scopeItems);
      refs.forEach(ref => referenceMap.set(ref.id, ref));
      if (refs.length > 0 && owner && !eventRoot) {
        eventRoot = owner;
      }
    };

    collectReferences(folderItems, folderBreadcrumb[folderBreadcrumb.length - 1]);

    for (let index = folderBreadcrumb.length - 2; index >= 1; index -= 1) {
      const ancestor = folderBreadcrumb[index];
      try {
        const result = await cloudApi.listGoogleFolder(ancestor.id);
        collectReferences(result.items || [], ancestor);
        if (eventRoot) break;
      } catch (error) {
        console.warn('Falha ao buscar referências no nível cloud:', ancestor.name, error);
      }
    }

    let recursivePhotos = folderInsights[folder.id]?.photoCount;
    let recursiveSubfolders = folderInsights[folder.id]?.subfolderCount;

    if (recursivePhotos === undefined || recursiveSubfolders === undefined) {
      try {
        const summary = await cloudApi.getGoogleFolderSummary(folder.id);
        recursivePhotos = summary.photos;
        recursiveSubfolders = summary.subfolders;
      } catch (e) {
        console.warn('Erro ao carregar resumo de pasta no draft:', folder.name, e);
      }
    }

    const fallbackEventRoot = eventRoot || folderBreadcrumb[1] || folderBreadcrumb[folderBreadcrumb.length - 1];
    const references = Array.from(referenceMap.values());
    return buildDraft(
      folder,
      sourceBreadcrumb,
      references.map(item => item.name),
      recursivePhotos !== undefined ? recursivePhotos : directPhotos.length,
      recursiveSubfolders !== undefined ? recursiveSubfolders : directFolders.length,
      fallbackEventRoot ? { id: fallbackEventRoot.id, name: fallbackEventRoot.name } : undefined,
      references.map(item => item.id),
    );
  }, [folderInsights]);

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
    if (cloudMode !== 'explorer' || loading || items.length === 0) return;

    let active = true;
    const foldersToSummarize = items.filter(item => {
      const isFolder = item.isFolder || item.mimeType === 'application/vnd.google-apps.folder';
      if (!isFolder) return false;
      
      if (fetchedSummariesRef.current.has(item.id)) return false;
      
      const insight = folderInsights[item.id];
      return !insight || insight.photoCount === undefined || insight.subfolderCount === undefined;
    });

    if (foldersToSummarize.length === 0) return;

    foldersToSummarize.forEach(f => fetchedSummariesRef.current.add(f.id));

    const fetchSummaries = async () => {
      for (const folder of foldersToSummarize) {
        if (!active) break;
        try {
          const summary = await cloudApi.getGoogleFolderSummary(folder.id);
          if (!active) break;
          setFolderInsights(prev => ({
            ...prev,
            [folder.id]: {
              ...prev[folder.id],
              photoCount: summary.photos,
              subfolderCount: summary.subfolders,
            }
          }));
        } catch (e) {
          console.warn('Erro ao carregar resumo de pasta:', folder.name, e);
          fetchedSummariesRef.current.delete(folder.id);
        }
      }
    };

    void fetchSummaries();

    return () => {
      active = false;
    };
  }, [items, cloudMode, loading]);

  useEffect(() => {
    if (cloudMode !== 'explorer' || loading || breadcrumb.length === 0) return;
    const directPhotos = items.filter(item => item.isImage || /^image\//.test(item.mimeType));
    if (directPhotos.length === 0) return;

    let active = true;
    const current = breadcrumb[breadcrumb.length - 1];
    const currentFolder: CloudItem = {
      id: current.id,
      name: current.name,
      mimeType: 'application/vnd.google-apps.folder',
      isFolder: true,
      parentId: breadcrumb[breadcrumb.length - 2]?.id,
    };

    setSelectedFolder(currentFolder);
    setPreparing(true);
    void prepareFolderDraft(currentFolder, breadcrumb, items)
      .then(nextDraft => {
        if (!active) return;
        setDraft(nextDraft);
        setFolderInsights(prev => ({
          ...prev,
          [currentFolder.id]: {
            ...prev[currentFolder.id],
            photoCount: nextDraft.totalFiles,
            subfolderCount: nextDraft.totalSubfolders ?? 0,
            referenceDetected: nextDraft.references.length > 0,
          },
        }));
      })
      .finally(() => {
        if (active) setPreparing(false);
      });

    return () => {
      active = false;
    };
  }, [breadcrumb, cloudMode, items, loading, prepareFolderDraft]);

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
    const folderBreadcrumb = [...breadcrumb, { id: folder.id, name: folder.name }];
    setDraft(buildDraft(folder, folderBreadcrumb.map(item => item.name)));
    setPreparing(true);
    try {
      const subfoldersResult = await cloudApi.listGoogleFolder(folder.id);
      const subfolders = subfoldersResult.items || [];
      const nextDraft = await prepareFolderDraft(folder, folderBreadcrumb, subfolders);
      setFolderInsights(prev => ({
        ...prev,
        [folder.id]: {
          ...prev[folder.id],
          photoCount: nextDraft.totalFiles,
          subfolderCount: nextDraft.totalSubfolders ?? subfolders.length,
          referenceDetected: nextDraft.references.length > 0,
        },
        ...Object.fromEntries(
          subfolders
            .filter(item => item.isFolder)
            .map(item => [item.id, { ...prev[item.id], referenceDetected: detectReferenceFolders([item]).length > 0 }])
        ),
      }));
      setDraft(nextDraft);
    } catch {
      setDraft(buildDraft(folder, folderBreadcrumb.map(item => item.name)));
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
    fetchedSummariesRef.current.clear();
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

    const formatNumberPtBR = (num: number) => {
      return new Intl.NumberFormat('pt-BR').format(num);
    };

    const totalFiles = selectedDraft.totalFiles || 0;
    let currentFiles = 0;
    let progressInterval: number | undefined;

    if (totalFiles > 0) {
      setCatalogProgress({
        percent: 10,
        label: `Processando fotos: 0 de ${formatNumberPtBR(totalFiles)}`
      });
      progressInterval = window.setInterval(() => {
        const targetLimit = Math.floor(totalFiles * 0.95);
        if (currentFiles < targetLimit) {
          const remaining = targetLimit - currentFiles;
          const increment = Math.max(1, Math.floor(remaining * 0.05));
          currentFiles = Math.min(targetLimit, currentFiles + increment);
          const percent = Math.min(95, Math.max(10, Math.floor((currentFiles / totalFiles) * 100)));
          setCatalogProgress({
            percent,
            label: `Processando fotos: ${formatNumberPtBR(currentFiles)} de ${formatNumberPtBR(totalFiles)}`
          });
        }
      }, 120);
    } else {
      let currentPercent = 10;
      setCatalogProgress({ percent: 10, label: 'Preparando catálogo...' });
      progressInterval = window.setInterval(() => {
        if (currentPercent < 95) {
          currentPercent = Math.min(95, currentPercent + Math.max(1, Math.floor((95 - currentPercent) * 0.05)));
          setCatalogProgress({
            percent: currentPercent,
            label: 'Processando fotos...'
          });
        }
      }, 120);
    }

    try {
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

      if (progressInterval) {
        window.clearInterval(progressInterval);
        progressInterval = undefined;
      }

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

      const finalCount = indexedDraft.totalFiles || totalFiles;
      setCatalogProgress({
        percent: 100,
        label: finalCount > 0
          ? `Catálogo criado! ${formatNumberPtBR(finalCount)} fotos processadas`
          : 'Catálogo criado!'
      });
      await new Promise(resolve => window.setTimeout(resolve, 800));

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
      if (progressInterval) {
        window.clearInterval(progressInterval);
        progressInterval = undefined;
      }
      setCatalogError(error?.message || 'Erro ao criar catálogo cloud. Tente novamente.');
      return null;
    } finally {
      if (progressInterval) {
        window.clearInterval(progressInterval);
      }
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
                hasMoreBackend={!!nextPageToken}
                loadingMoreBackend={loadingMore}
                onLoadMoreBackend={handleLoadMoreBackend}
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
                ) : selectedDraft && (
                  preparing || 
                  selectedDraft.totalFiles > 0 || 
                  (selectedDraft.totalSubfolders ?? selectedDraft.subfolderCount ?? 0) > 0 || 
                  selectedDraft.references.length > 0
                ) ? (
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
                <div className={styles.workspaceHeader}>
                  <div className={styles.workspaceHeaderTitle}>
                    <span title={workspaceSession?.currentPathJson?.map(i => i.name).join(' > ') || workspaceCatalog.sourceFolderName || workspaceCatalog.name}>
                      {workspaceCatalog.name}
                    </span>
                    <small>Status: {workspaceCatalog.status === 'indexed' ? 'Indexado' : workspaceCatalog.status}</small>
                  </div>
                  <div className={styles.workspaceHeaderControls}>
                    <span className={styles.workspaceHeaderCounter}>
                      <strong>{filteredPhotos.length}</strong> fotos
                    </span>
                    <PhotoFilters
                      filter={filter}
                      onFilterChange={setFilter}
                      hideDiscarded={hideDiscarded}
                      onHideDiscardedChange={setHideDiscarded}
                    />
                    <ZoomControl zoom={zoom} onZoom={setZoom} min={0} max={100} step={5} />
                  </div>
                </div>

                <div className={styles.gridContent}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, position: 'relative' }}>
                    {photosLoading && photos.length === 0 ? (
                      <div className={styles.loadingMore}>
                        <RefreshCw size={24} className={styles.spin} />
                        <p>Carregando fotos do catálogo...</p>
                      </div>
                    ) : (
                      <VirtualizedPhotoGrid
                        photos={filteredPhotos}
                        selectedPaths={selectedPaths}
                        onPhotoClick={toggleSelection}
                        onDoubleClick={setViewerPhoto}
                        onOpenDetails={setDetailsPhoto}
                        onLoadMore={loadMorePhotos}
                        hasMore={photosHasMore}
                        loadingMore={photosLoadingMore}
                        zoom={size}
                        getSelectionCount={getSelectionCount}
                        resetScrollKey={`${workspaceCatalog.name}|${filter}|${hideDiscarded ? '1' : '0'}`}
                        scrollRef={gridScrollRef}
                      />
                    )}
                  </div>

                  {detailsPhoto && (
                    <PhotoDetailPanel
                      photo={detailsPhoto}
                      onClose={() => setDetailsPhoto(null)}
                    />
                  )}
                </div>
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

        {viewerPhoto && (
          <PhotoViewerModal
            photo={viewerPhoto}
            allPhotos={filteredPhotos}
            onClose={() => setViewerPhoto(null)}
            onNavigate={setViewerPhoto}
            onDiscard={discardPhoto}
            onRestore={restorePhoto}
          />
        )}

        {selectedPaths.size > 0 && !viewerPhoto && (
          <PhotoBulkActionsBar
            selectedCount={selectedPaths.size}
            onDiscard={handleDiscardSelected}
            onRestore={handleRestoreSelected}
            onRemoveIdentification={handleRemoveIdentificationSelected}
            onClearSelection={clearSelection}
          />
        )}
        </>
      )}
    </div>
  );
}
