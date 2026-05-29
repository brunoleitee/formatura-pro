import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { api, catalogApi } from '../services/api';
import { findCommonPrefix, normalizePath } from '../utils/catalogPathUtils';

export type ViewName =
  | 'dashboard'
  | 'photos'
  | 'people'
  | 'person-detail'
  | 'review'
  | 'export'
  | 'settings'
  | 'catalog-settings'
  | 'scanner'
  ;

export interface PendingScanConfig {
  eventPath: string;
  refPath: string;
  catalogName: string;
}

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
  catalogRootPath: string;
  pendingScanConfig: PendingScanConfig | null;
  setCatalogSubfolder: (s: string | null) => void;
  setCatalogSubfolders: (folders: string[]) => void;
  setIsLoadingCatalogPhotos: (loading: boolean) => void;
  setCatalog: (name: string) => Promise<void>;
  refreshCatalogs: () => Promise<void>;
  bumpRefresh: () => void;
  navigate: (view: ViewName, personId?: string) => void;
  accentColor: string;
  setAccentColor: (color: string) => void;
  setPendingScanConfig: (cfg: PendingScanConfig | null) => void;
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
  const [catalogRootPath, setCatalogRootPath] = useState('');
  const [pendingScanConfig, setPendingScanConfig] = useState<PendingScanConfig | null>(null);
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accent_color') || 'blue');

  useEffect(() => {
    const style = document.documentElement.style;
    if (accentColor.startsWith('custom_')) {
      const hex = accentColor.replace('custom_', '');
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const dark = document.documentElement.classList.contains('dark');
      const softAlpha = dark ? 0.15 : 0.08;
      const glowAlpha = dark ? 0.08 : 0.04;
      const bgAlpha = dark ? 0.12 : 0.08;
      const borderAlpha = dark ? 0.35 : 0.25;
      const hover = `rgb(${Math.round(r * 0.8)}, ${Math.round(g * 0.8)}, ${Math.round(b * 0.8)})`;
      style.setProperty('--accent', hex);
      style.setProperty('--accent-hover', hover);
      style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, ${softAlpha})`);
      style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, ${glowAlpha})`);
      style.setProperty('--bg-active', `rgba(${r}, ${g}, ${b}, ${bgAlpha})`);
      style.setProperty('--border-accent', `rgba(${r}, ${g}, ${b}, ${borderAlpha})`);
      style.setProperty('--accent-primary', hex);
      style.setProperty('--hero-btn-bg', hex);
      style.setProperty('--hero-btn-bg-hover', hover);
      style.setProperty('--toolbar-accent', hex);
      style.setProperty('--toolbar-bg-accent', hex);
      style.setProperty('--bulkbar-accent-bg', hex);
      style.setProperty('--ws-border-active', hex);
      style.setProperty('--ws-overlay-accent', `rgba(${r}, ${g}, ${b}, 0.9)`);
      document.documentElement.setAttribute('data-accent', 'blue');
    } else {
      const vars = ['--accent', '--accent-hover', '--accent-soft', '--accent-glow', '--bg-active', '--border-accent', '--accent-primary', '--hero-btn-bg', '--hero-btn-bg-hover', '--toolbar-accent', '--toolbar-bg-accent', '--bulkbar-accent-bg', '--ws-border-active', '--ws-overlay-accent'];
      for (const v of vars) style.removeProperty(v);
      document.documentElement.setAttribute('data-accent', accentColor);
    }
    localStorage.setItem('accent_color', accentColor);
  }, [accentColor]);

  const refreshCatalogs = useCallback(async () => {
    setIsLoadingCatalogs(true);
    try {
      const data = await api.getCatalogs();
      setIsBackendOnline(true);
      setCatalogs(data.catalogs);
      if (data.current) {
        setCurrentCatalog(data.current);
        try {
          const settings = await catalogApi.getCatalogSettings(data.current);
          setCatalogRootPath(settings.root_path || '');
        } catch {
          setCatalogRootPath('');
        }
      } else if (data.catalogs.length > 0) {
        const toSelect = data.catalogs[0];
        await api.setCatalog(toSelect);
        setCurrentCatalog(toSelect);
        try {
          const settings = await catalogApi.getCatalogSettings(toSelect);
          setCatalogRootPath(settings.root_path || '');
        } catch {
          setCatalogRootPath('');
        }
      } else {
        setCurrentCatalog('');
        setCatalogRootPath('');
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
      try {
        const settings = await catalogApi.getCatalogSettings(name);
        setCatalogRootPath(settings.root_path || '');
      } catch {
        setCatalogRootPath('');
      }
    } catch (e) {
      console.error('Erro ao definir catálogo:', e);
    }
  }, []);

  const bumpRefresh = useCallback(() => setRefreshKey(k => k + 1), []);

  // Polling e sincronização global de subpastas do catálogo
  useEffect(() => {
    if (!currentCatalog) {
      setCatalogSubfolders([]);
      return;
    }
    
    setIsLoadingCatalogPhotos(true);
    catalogApi.getAllSubfolders(currentCatalog).then(res => {
      if (res && res.ok && Array.isArray(res.subfolders)) {
        // Calcula o prefixo comum apenas a partir das subpastas mapeadas no disco
        const prefix = findCommonPrefix(res.subfolders);
        
        const relativeSubfolders = res.subfolders.map(folder => {
          const normFolder = normalizePath(folder);
          const normPrefix = normalizePath(prefix);
          
          if (normPrefix && normFolder.toLowerCase().startsWith(normPrefix.toLowerCase() + '/')) {
            return normFolder.slice(normPrefix.length + 1);
          } else if (normPrefix && normFolder.toLowerCase() === normPrefix.toLowerCase()) {
            return '';
          }
          return folder.split(/[\\/]/).filter(Boolean).pop() || '';
        }).filter(Boolean);
        
        const sortedUnique = Array.from(new Set(relativeSubfolders))
          .filter(s => s.length > 0)
          .sort((a, b) => a.localeCompare(b, 'pt-BR'));
          
        setCatalogSubfolders(sortedUnique);
      }
    }).catch(err => {
      console.warn('[AppContext] falha ao buscar subpastas de forma global:', err);
    }).finally(() => {
      setIsLoadingCatalogPhotos(false);
    });
  }, [currentCatalog, refreshKey]);

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
      catalogRootPath,
      pendingScanConfig,
      setCatalogSubfolder,
      setCatalogSubfolders,
      setIsLoadingCatalogPhotos,
      setCatalog,
      refreshCatalogs,
      bumpRefresh,
      navigate,
      accentColor,
      setAccentColor,
      setPendingScanConfig,
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
