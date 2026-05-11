import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { api } from '../services/api';

export type ViewType = 'photos' | 'people' | 'review' | 'export' | 'settings';

interface AppContextType {
  currentCatalog: string;
  catalogs: string[];
  activeView: ViewType;
  isLoading: boolean;
  
  changeCatalog: (catalog: string) => Promise<void>;
  refreshCatalogs: () => Promise<void>;
  navigate: (view: ViewType) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [currentCatalog, setCurrentCatalog] = useState<string>('');
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [activeView, setActiveView] = useState<ViewType>('photos');
  const [isLoading, setIsLoading] = useState(true);

  const refreshCatalogs = async () => {
    try {
      const data = await api.getCatalogs();
      setCatalogs(data.catalogs);
      setCurrentCatalog(data.current);
    } catch (error) {
      console.error("Error fetching catalogs:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const changeCatalog = async (catalog: string) => {
    try {
      setIsLoading(true);
      await api.setCatalog(catalog);
      await refreshCatalogs();
    } catch (error) {
      console.error("Error changing catalog:", error);
      setIsLoading(false);
    }
  };

  const navigate = (view: ViewType) => {
    setActiveView(view);
  };

  useEffect(() => {
    refreshCatalogs();
  }, []);

  return (
    <AppContext.Provider
      value={{
        currentCatalog,
        catalogs,
        activeView,
        isLoading,
        changeCatalog,
        refreshCatalogs,
        navigate,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
}
