import { useState, useEffect, useRef } from 'react';
import {
  FolderOpen, ChevronDown, ChevronLeft, ChevronRight, Trash2,
  Image as ImageIcon, Users, UserCheck, Download, LayoutDashboard,
  Settings, Search, ScanLine, Loader, Users as UsersIcon,
  Cloud, MoreHorizontal,
} from 'lucide-react';
import { useApp, type ViewName } from '../../context/AppContext';
import { api } from '../../services/api';
import { useLocalStorage } from '../../hooks/useLocalStorage';

interface SidebarProps {
  showCatalogDropdown: boolean;
  setShowCatalogDropdown: React.Dispatch<React.SetStateAction<boolean>>;
  setShowCatalogModal: React.Dispatch<React.SetStateAction<boolean>>;
  onScanClick: () => void;
  isScanning: boolean;
  scanMsg: string;
  scanProgress: number;
  onRequestConfirm: (options: { title: string; message: string; confirmText: string; cancelText: string }) => Promise<boolean>;
}

type NavItemDef = {
  view: ViewName;
  icon: React.ReactNode;
  label: string;
  badge?: number | 'new' | null;
  hasSubmenu?: boolean;
};

export function Sidebar({
  showCatalogDropdown,
  setShowCatalogDropdown,
  setShowCatalogModal,
  onScanClick,
  isScanning,
  scanMsg,
  scanProgress,
  onRequestConfirm,
}: SidebarProps) {
  const {
    currentCatalog, catalogs, activeView, navigate, setCatalog, refreshCatalogs,
    catalogSubfolder, catalogSubfolders, setCatalogSubfolder, isLoadingCatalogPhotos,
    refreshKey,
  } = useApp();

  const [collapsed, setCollapsed] = useLocalStorage<boolean>('sidebar_collapsed', false);
  const [openSubmenu, setOpenSubmenu] = useLocalStorage<string>('sidebar_open_submenu', '');
  const [sidebarStats, setSidebarStats] = useState<{ photos: number; people: number } | null>(null);
  const [flyout, setFlyout] = useState<{ key: string; y: number } | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});

  const toggleExpand = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    setExpandedPaths(prev => ({
      ...prev,
      [path]: prev[path] === false ? true : false
    }));
  };

  const isSubfolderVisible = (path: string) => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parentPath = parts.slice(0, i).join('/');
      if (expandedPaths[parentPath] === false) {
        return false;
      }
    }
    return true;
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ name: string; catalog: string }[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!currentCatalog) { setSidebarStats(null); return; }
    const controller = new AbortController();
    api.getStats(currentCatalog, controller.signal)
      .then(s => {
        if (!controller.signal.aborted) {
          setSidebarStats({ photos: s.total_photos, people: s.total_people });
        }
      })
      .catch((e) => {
        if (e?.name !== 'AbortError') {
          // ignore
        }
      });
    return () => { controller.abort(); };
  }, [currentCatalog, refreshKey]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearch(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!flyout) return;
    const handler = (e: MouseEvent) => {
      if (flyoutRef.current && !flyoutRef.current.contains(e.target as Node)) {
        setFlyout(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [flyout]);

  const [searchLoading, setSearchLoading] = useState(false);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = (q: string) => {
    setSearchQuery(q);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (q.length < 2) {
      setSearchResults([]);
      setShowSearch(false);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    searchTimerRef.current = setTimeout(async () => {
      if (searchAbortRef.current) searchAbortRef.current.abort();
      searchAbortRef.current = new AbortController();
      try {
        const res = await api.globalSearch(q);
        setSearchResults(res);
        setShowSearch(true);
      } catch { /* ignore */ } finally {
        setSearchLoading(false);
      }
    }, 300);
  };

  const fmtBadge = (n: number) => {
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  };

  const toggleSubmenu = (view: string) => {
    setOpenSubmenu(prev => prev === view ? '' : view);
  };

  const navItems: NavItemDef[] = [
    { view: 'dashboard', icon: <LayoutDashboard size={17} />, label: 'Visão Geral' },
    { view: 'photos',    icon: <ImageIcon size={17} />,       label: 'Catálogo',   badge: sidebarStats?.photos ?? null, hasSubmenu: true },
    { view: 'people',    icon: <Users size={17} />,           label: 'Formandos',  badge: sidebarStats?.people ?? null },
    { view: 'review',    icon: <UserCheck size={17} />,       label: 'Revisão IA', badge: 'new' },
  ];

  const toolItems: { view: ViewName; icon: React.ReactNode; label: string }[] = [
    { view: 'export',     icon: <Download size={17} />,  label: 'Exportador' },
    { view: 'cloud-sync', icon: <Cloud size={17} />,     label: 'Sincronização na Nuvem' },
    { view: 'settings',   icon: <Settings size={17} />,  label: 'Configurações' },
  ];

  const isNavActive = (item: NavItemDef) =>
    activeView === item.view ||
    (item.view === 'people' && activeView === 'person-detail') ||
    (item.view === 'photos' && activeView === 'catalog-settings');

  const folderColor = (isActive: boolean) => isActive ? '#e8a020' : 'var(--text-muted)';

  return (
    <div className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}>
      {/* Toggle collapse */}
      <button
        className="sidebar-toggle"
        onClick={() => { setCollapsed(v => !v); setFlyout(null); }}
        type="button"
        title={collapsed ? 'Expandir sidebar' : 'Recolher sidebar'}
      >
        {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
      </button>

      {/* Logo — não alterar */}
      <div className="sidebar-header">
        <svg viewBox="0 0 100 100" width={28} height={28} xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
          <defs>
            <linearGradient id="brandLogoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#f1f1f1" />
              <stop offset="50%" stopColor="#d9d9d9" />
              <stop offset="100%" stopColor="#c7c7c7" />
            </linearGradient>
          </defs>
          <path d="M20,0 L50,0 L50,25 L25,25 L25,50 L0,50 L0,20 Q0,0 20,0 Z" fill="url(#brandLogoGrad)" />
          <path d="M50,0 L80,0 Q100,0 100,20 L100,50 L75,50 L75,25 L50,25 Z" fill="url(#brandLogoGrad)" />
          <path d="M0,50 L25,50 L25,75 L50,75 L50,100 L20,100 Q0,100 0,80 L0,50 Z" fill="url(#brandLogoGrad)" />
          <path d="M75,50 L100,50 L100,80 Q100,100 80,100 L50,100 L50,75 L75,75 L75,50 Z" fill="url(#brandLogoGrad)" />
        </svg>
        <h2 style={{ fontSize: '1rem', fontWeight: 700 }}>Formatura PRO</h2>
      </div>

      {/* Seletor de catálogo */}
      {!collapsed && (
        <div className="catalog-selector-wrap">
          <div className="catalog-selector" onClick={() => setShowCatalogDropdown(v => !v)}>
            {currentCatalog && <span className="catalog-active-dot" />}
            <FolderOpen size={15} />
            <span className="catalog-selector-name">{currentCatalog || 'Selecionar evento...'}</span>
            <ChevronDown size={14} style={{ marginLeft: 'auto', flexShrink: 0 }} />
          </div>
          {showCatalogDropdown && (
            <div className="catalog-dropdown">
              {catalogs.map(cat => (
                <div key={cat} className={`catalog-dropdown-row ${cat === currentCatalog ? 'active' : ''}`}>
                  <button
                    className="catalog-dropdown-label"
                    onClick={async () => { await setCatalog(cat); setShowCatalogDropdown(false); }}
                  >
                    <span className={`catalog-row-dot${cat === currentCatalog ? ' active' : ''}`} />
                    <span className="catalog-dropdown-text">{cat}</span>
                  </button>
                  <button
                    className="icon-btn danger"
                    style={{ flexShrink: 0, padding: '4px 6px' }}
                    title="Excluir evento"
                    onClick={async (e) => {
                      e.stopPropagation();
                      const confirmed = await onRequestConfirm({
                        title: 'Excluir evento?',
                        message: `Excluir o evento "${cat}"? Esta ação não pode ser desfeita.`,
                        confirmText: 'Excluir',
                        cancelText: 'Cancelar',
                      });
                      if (!confirmed) return;
                      try { await api.deleteCatalog(cat); await refreshCatalogs(); } catch { /* ignore */ }
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <button
                className="catalog-dropdown-item create"
                onClick={() => { setShowCatalogDropdown(false); setShowCatalogModal(true); }}
              >
                + Novo evento
              </button>
            </div>
          )}
        </div>
      )}

      {/* Busca global */}
      {!collapsed && (
        <div className="sidebar-search-wrap" ref={searchRef}>
          <div className="sidebar-search">
            {searchLoading
              ? <span style={{ display: 'inline-block', width: 13, height: 13, border: '1.5px solid rgba(255,255,255,0.15)', borderTopColor: 'var(--accent,#7c5cbf)', borderRadius: '50%', animation: 'spin 0.75s linear infinite', flexShrink: 0 }} />
              : <Search size={13} />
            }
            <input
              type="text"
              placeholder="Buscar formando..."
              value={searchQuery}
              onChange={e => handleSearch(e.target.value)}
              onFocus={() => (searchResults.length > 0 || searchQuery.length >= 2) && setShowSearch(true)}
            />
            {searchQuery && (
              <button
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: 'var(--text-muted)', lineHeight: 1 }}
                onClick={() => { setSearchQuery(''); setSearchResults([]); setShowSearch(false); }}
                title="Limpar busca"
              >×</button>
            )}
          </div>
          {showSearch && (
            <div className="sidebar-search-results">
              {searchResults.length > 0 ? searchResults.map((r, i) => (
                <button
                  key={i}
                  className="sidebar-search-result"
                  onClick={() => {
                    setSearchQuery('');
                    setShowSearch(false);
                    navigate('person-detail', r.name);
                  }}
                >
                  <UsersIcon size={13} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span style={{ fontSize: '0.7rem', opacity: 0.5, flexShrink: 0 }}>{r.catalog}</span>
                </button>
              )) : !searchLoading && (
                <div style={{ padding: '8px 12px', fontSize: '0.78rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                  Nenhum formando encontrado
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Navegação */}
      <div className="sidebar-nav">
        <div className="nav-section">
          {!collapsed && <div className="nav-section-title">Biblioteca</div>}
          {navItems.map(item => {
            const isActive = isNavActive(item);
            const isOpen = openSubmenu === item.view;

            return (
              <div key={item.view}>
                <div
                  className={`nav-item ${isActive ? 'active' : ''}`}
                  title={collapsed ? item.label : undefined}
                  onClick={(e) => {
                    if (collapsed && item.hasSubmenu && currentCatalog) {
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setFlyout(prev => prev?.key === item.view ? null : { key: item.view, y: rect.top });
                      return;
                    }
                    navigate(item.view);
                    if (item.hasSubmenu && currentCatalog) toggleSubmenu(item.view);
                  }}
                >
                  {item.icon}
                  {!collapsed && (
                    <span className="nav-item-label">{item.label}</span>
                  )}
                  {!collapsed && (
                    <span className="nav-item-right">
                      {item.badge === 'new' && <span className="nav-badge nav-badge-new">Novo</span>}
                      {typeof item.badge === 'number' && item.badge > 0 && (
                        <span className="nav-badge">{fmtBadge(item.badge)}</span>
                      )}
                      {item.hasSubmenu && currentCatalog && (
                        <ChevronDown
                          size={12}
                          className={`nav-chevron${isOpen ? ' nav-chevron-open' : ''}`}
                        />
                      )}
                    </span>
                  )}
                </div>

                {/* Accordion submenu — só no modo expandido */}
                {item.hasSubmenu && !collapsed && currentCatalog && (
                  <div className={`nav-submenu${isOpen ? ' nav-submenu-open' : ''}`}>
                    <div className="nav-submenu-group">Fotos</div>
                    {isLoadingCatalogPhotos ? (
                      <div className="nav-subitem nav-subitem-muted">Carregando...</div>
                    ) : catalogSubfolders.length === 0 ? (
                      <div className="nav-subitem nav-subitem-muted">Nenhuma pasta</div>
                    ) : (
                      catalogSubfolders.map(sub => {
                        if (!isSubfolderVisible(sub)) return null;

                        const subActive = catalogSubfolder === sub && activeView === 'photos';
                        const segments = sub.split('/');
                        const depth = segments.length - 1;
                        const displayName = segments[segments.length - 1];
                        const isParent = catalogSubfolders.some(other => other.startsWith(sub + '/'));
                        const isExpanded = expandedPaths[sub] !== false;

                        return (
                          <div
                            key={sub}
                            className={`nav-subitem${depth > 0 ? ' nav-subitem-nested' : ''}${subActive ? ' active' : ''}`}
                            onClick={() => { setCatalogSubfolder(sub); navigate('photos'); }}
                            style={{ paddingLeft: `${12 + depth * 14}px` }}
                          >
                            {isParent ? (
                              <div
                                onClick={(e) => toggleExpand(e, sub)}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: '14px',
                                  height: '14px',
                                  marginRight: '2px',
                                  cursor: 'pointer',
                                  opacity: 0.6,
                                }}
                              >
                                {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                              </div>
                            ) : (
                              <div style={{ width: '16px' }} />
                            )}
                            <FolderOpen size={13} style={{ color: folderColor(subActive), flexShrink: 0 }} />
                            <span style={{ fontWeight: subActive ? '600' : 'normal' }}>{displayName}</span>
                          </div>
                        );
                      })
                    )}
                    <div
                      className={`nav-subitem nav-subitem-settings${activeView === 'catalog-settings' ? ' active' : ''}`}
                      onClick={() => { setCatalogSubfolder(null); navigate('catalog-settings'); }}
                    >
                      <Settings size={12} style={{ color: folderColor(activeView === 'catalog-settings'), flexShrink: 0 }} />
                      <span>Configurações</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="nav-section">
          {!collapsed && <div className="nav-section-title">Ferramentas</div>}

          {/* Escanear */}
          <div
            className={`nav-item ${activeView === 'scanner' ? 'active' : ''} ${isScanning ? 'sidebar-scanning' : ''}`}
            onClick={() => { if (currentCatalog) onScanClick(); }}
            style={{ opacity: !currentCatalog ? 0.4 : 1, cursor: !currentCatalog ? 'default' : 'pointer' }}
            title={collapsed
              ? 'Escanear'
              : !currentCatalog
                ? 'Selecione um evento primeiro'
                : isScanning
                  ? 'Abrir central de processamento'
                  : 'Escanear fotos'
            }
          >
            {isScanning ? <Loader size={17} className="spin" /> : <ScanLine size={17} />}
            {!collapsed && <span className="nav-item-label">Escanear</span>}
            {!collapsed && isScanning && (
              <span className="nav-item-right">
                <span className="sidebar-scan-badge">em andamento</span>
              </span>
            )}
          </div>

          {toolItems.map(item => (
            <div
              key={item.view}
              className={`nav-item ${activeView === item.view ? 'active' : ''}`}
              onClick={() => navigate(item.view)}
              title={collapsed ? item.label : undefined}
            >
              {item.icon}
              {!collapsed && <span className="nav-item-label">{item.label}</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Progresso do scan */}
      {isScanning && !collapsed && (
        <div className="sidebar-scan-footer">
          <div className="sidebar-scan-progress">
            <div className="sidebar-scan-progress-fill" style={{ width: `${scanProgress}%` }} />
          </div>
          {scanMsg && <span className="sidebar-scan-msg">{scanMsg}</span>}
        </div>
      )}

      {/* Rodapé: card de usuário */}
      <div className="sidebar-user-divider" />
      <div className={`sidebar-user-card${collapsed ? ' sidebar-user-card-collapsed' : ''}`}>
        <div className="sidebar-user-avatar">BL</div>
        {!collapsed && (
          <>
            <div className="sidebar-user-info">
              <span className="sidebar-user-name">Bruno Leite</span>
              <span className="sidebar-user-role">Administrador</span>
            </div>
            <button className="sidebar-user-menu" type="button" title="Menu">
              <MoreHorizontal size={15} />
            </button>
          </>
        )}
      </div>

      {/* Flyout — modo colapsado: submenu de Catálogo */}
      {flyout?.key === 'photos' && (
        <div
          ref={flyoutRef}
          className="sidebar-flyout"
          style={{ top: flyout.y }}
        >
          <div className="sidebar-flyout-title">Catálogo</div>
            {catalogSubfolders.map(sub => {
             if (!isSubfolderVisible(sub)) return null;

             const subActive = catalogSubfolder === sub && activeView === 'photos';
             const segments = sub.split('/');
             const depth = segments.length - 1;
             const displayName = segments[segments.length - 1];
             const isParent = catalogSubfolders.some(other => other.startsWith(sub + '/'));
             const isExpanded = expandedPaths[sub] !== false;

             return (
               <div
                 key={sub}
                 className={`sidebar-flyout-item${subActive ? ' active' : ''}`}
                 onClick={() => { setCatalogSubfolder(sub); navigate('photos'); setFlyout(null); }}
                 style={{ paddingLeft: `${12 + depth * 12}px` }}
               >
                 {isParent ? (
                   <div
                     onClick={(e) => toggleExpand(e, sub)}
                     style={{
                       display: 'flex',
                       alignItems: 'center',
                       justifyContent: 'center',
                       width: '14px',
                       height: '14px',
                       marginRight: '2px',
                       cursor: 'pointer',
                       opacity: 0.6,
                     }}
                   >
                     {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                   </div>
                 ) : (
                   <div style={{ width: '16px' }} />
                 )}
                 <FolderOpen size={13} style={{ color: folderColor(subActive), flexShrink: 0 }} />
                 <span style={{ fontWeight: subActive ? '600' : 'normal' }}>{displayName}</span>
               </div>
             );
           })}
          <div
            className={`sidebar-flyout-item${activeView === 'catalog-settings' ? ' active' : ''}`}
            onClick={() => { setCatalogSubfolder(null); navigate('catalog-settings'); setFlyout(null); }}
            style={{ borderTop: '1px solid rgba(255,255,255,0.07)', marginTop: 4, paddingTop: 8 }}
          >
            <Settings size={13} style={{ flexShrink: 0 }} />
            <span>Configurações</span>
          </div>
        </div>
      )}
    </div>
  );
}
