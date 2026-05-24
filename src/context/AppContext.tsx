import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { api } from '../services/api';

export type ViewName =
  | 'dashboard'
  | 'photos'
  | 'people'
  | 'person-detail'
  | 'review'
  | 'export'
  | 'settings'
  | 'cloud-sync'
  | 'catalog-settings'
  | 'scanner'
  ;

interface AppContextValue {
  currentCatalog: string;
  catalogs: string[];
  isLoadingCatalogs: boolean;
  activeView: ViewName;
  selectedPersonId: string | null;
  refreshKey: number;
  catalogSubfolder: string | null;
  catalogSubfolders: string[];
  isLoadingCatalogPhotos: boolean;
  isBackendOnline: boolean;
  setCatalogSubfolder: (s: string | null) => void;
  setCatalogSubfolders: (folders: string[]) => void;
  setIsLoadingCatalogPhotos: (loading: boolean) => void;
  setCatalog: (name: string) => Promise<void>;
  refreshCatalogs: () => Promise<void>;
  bumpRefresh: () => void;
  navigate: (view: ViewName, personId?: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [currentCatalog, setCurrentCatalog] = useState('');
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [isLoadingCatalogs, setIsLoadingCatalogs] = useState(true);
  const [activeView, setActiveView] = useState<ViewName>('dashboard');
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [catalogSubfolder, setCatalogSubfolder] = useState<string | null>(null);
  const [catalogSubfolders, setCatalogSubfolders] = useState<string[]>([]);
  const [isLoadingCatalogPhotos, setIsLoadingCatalogPhotos] = useState(false);
  const [isBackendOnline, setIsBackendOnline] = useState(true);

  const refreshCatalogs = useCallback(async () => {
    setIsLoadingCatalogs(true);
    try {
      const data = await api.getCatalogs();
      setIsBackendOnline(true);
      setCatalogs(data.catalogs);
      if (data.current) {
        setCurrentCatalog(data.current);
      } else if (data.catalogs.length > 0) {
        // Backend reiniciou e perdeu o catálogo selecionado — re-afirmar
        const toSelect = data.catalogs[0];
        await api.setCatalog(toSelect);
        setCurrentCatalog(toSelect);
      }
    } catch (e) {
      console.error('Erro ao carregar catálogos:', e);
      setIsBackendOnline(false);
    } finally {
      setIsLoadingCatalogs(false);
    }
  }, []);

  // Polling periódico (Heartbeat) de conexão para diagnosticar instabilidade do backend
  useEffect(() => {
    let timer: number;
    const checkConnection = async () => {
      try {
        await api.getSystemStatus();
        setIsBackendOnline(true);
      } catch (e) {
        setIsBackendOnline(false);
      }
    };

    // Polling a cada 5s se saudável, ou 2.5s se offline para reconexão célere
    timer = window.setInterval(checkConnection, isBackendOnline ? 5000 : 2500);

    return () => window.clearInterval(timer);
  }, [isBackendOnline]);

  // Forçar atualização do catálogo local ao reconectar
  useEffect(() => {
    if (isBackendOnline && catalogs.length === 0) {
      refreshCatalogs();
    }
  }, [isBackendOnline, catalogs.length, refreshCatalogs]);

  const setCatalog = useCallback(async (name: string) => {
    try {
      await api.setCatalog(name);
      setCurrentCatalog(name);
      setCatalogSubfolder(null);
      setCatalogSubfolders([]);
    } catch (e) {
      console.error('Erro ao definir catálogo:', e);
    }
  }, []);

  const bumpRefresh = useCallback(() => setRefreshKey(k => k + 1), []);

  const navigate = useCallback((view: ViewName, personId?: string) => {
    setActiveView(view);
    if (personId !== undefined) setSelectedPersonId(personId);
  }, []);

  return (
    <AppContext.Provider value={{
      currentCatalog,
      catalogs,
      isLoadingCatalogs,
      activeView,
      selectedPersonId,
      refreshKey,
      catalogSubfolder,
      catalogSubfolders,
      isLoadingCatalogPhotos,
      isBackendOnline,
      setCatalogSubfolder,
      setCatalogSubfolders,
      setIsLoadingCatalogPhotos,
      setCatalog,
      refreshCatalogs,
      bumpRefresh,
      navigate,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be inside AppProvider');
  return ctx;
}
