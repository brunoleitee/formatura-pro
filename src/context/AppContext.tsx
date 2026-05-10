import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { api } from '../services/api';

export type ViewName =
  | 'photos'
  | 'people'
  | 'person-detail'
  | 'review'
  | 'export'
  | 'settings';

interface AppContextValue {
  currentCatalog: string;
  catalogs: string[];
  isLoadingCatalogs: boolean;
  activeView: ViewName;
  selectedPersonId: string | null;
  refreshKey: number;
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
  const [activeView, setActiveView] = useState<ViewName>('people');
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refreshCatalogs = useCallback(async () => {
    setIsLoadingCatalogs(true);
    try {
      const data = await api.getCatalogs();
      setCatalogs(data.catalogs);
      if (data.current) setCurrentCatalog(data.current);
    } catch (e) {
      console.error('Erro ao carregar catálogos:', e);
    } finally {
      setIsLoadingCatalogs(false);
    }
  }, []);

  const setCatalog = useCallback(async (name: string) => {
    try {
      await api.setCatalog(name);
      setCurrentCatalog(name);
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
