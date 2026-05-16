import { useState, useEffect, useRef } from 'react';
import {
  FolderOpen, ChevronDown, ChevronRight, Trash2,
  Image as ImageIcon, Users, UserCheck, Download, LayoutDashboard,
  Settings, Search, ScanLine, Loader, Users as UsersIcon,
  Folder, Cloud, FolderTree,
} from 'lucide-react';
import { useApp, type ViewName } from '../../context/AppContext';
import { api } from '../../services/api';
import ftStyles from './SidebarFolderTree.module.css';

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
  } = useApp();

  // Busca global
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ name: string; catalog: string }[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  // Árvore de pastas do catálogo
  const [folderTreeExpanded, setFolderTreeExpanded] = useState(true);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearch(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSearch = async (q: string) => {
    setSearchQuery(q);
    if (q.length < 2) { setSearchResults([]); setShowSearch(false); return; }
    try {
      const res = await api.globalSearch(q);
      setSearchResults(res);
      setShowSearch(res.length > 0);
    } catch { /* ignore */ }
  };

  const navItems: { view: ViewName; icon: React.ReactNode; label: string }[] = [
    { view: 'dashboard', icon: <LayoutDashboard size={17} />, label: 'Painel' },
    { view: 'photos',  icon: <ImageIcon size={17} />, label: 'Catálogo' },
    { view: 'people',  icon: <Users size={17} />,     label: 'Formandos' },
    { view: 'review',  icon: <UserCheck size={17} />, label: 'Revisão IA' },
  ];

const toolItems: { view: ViewName; icon: React.ReactNode; label: string }[] = [
    { view: 'export',   icon: <Download size={17} />,  label: 'Exportador' },
    { view: 'events-references', icon: <FolderTree size={17} />,  label: 'Eventos & Referências' },
    { view: 'cloud-sync', icon: <Cloud size={17} />,  label: 'Sincronização na Nuvem' },
    { view: 'settings', icon: <Settings size={17} />,  label: 'Configurações' },
  ];

  const shouldShowCatalogTree =
    activeView === 'photos' && !!currentCatalog;

  return (
    <div className="sidebar">
      {/* Logo */}
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
      <div className="catalog-selector-wrap">
        <div className="catalog-selector" onClick={() => setShowCatalogDropdown(v => !v)}>
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
                  {cat}
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

      {/* Busca global */}
      <div className="sidebar-search-wrap" ref={searchRef}>
        <div className="sidebar-search">
          <Search size={13} />
          <input
            type="text"
            placeholder="Buscar formando..."
            value={searchQuery}
            onChange={e => handleSearch(e.target.value)}
            onFocus={() => searchResults.length > 0 && setShowSearch(true)}
          />
        </div>
        {showSearch && (
          <div className="sidebar-search-results">
            {searchResults.map((r, i) => (
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
            ))}
          </div>
        )}
      </div>

      {/* Navegação */}
      <div className="sidebar-nav">
        <div className="nav-section">
          <div className="nav-section-title">Biblioteca</div>
          {navItems.map(item => (
            <div key={item.view}>
              <div
                className={`nav-item ${activeView === item.view || (item.view === 'people' && activeView === 'person-detail') ? 'active' : ''}`}
                onClick={() => navigate(item.view)}
              >
                {item.icon}
                <span>{item.label}</span>
              </div>

              {/* Árvore de pastas embutida abaixo do item Catálogo */}
              {item.view === 'photos' && shouldShowCatalogTree && (
                <div className={ftStyles.tree}>
                  {/* Linha raiz */}
                  <div className={`${ftStyles.rootRow} ${catalogSubfolder === null ? ftStyles.active : ''}`}>
                    <button
                      className={ftStyles.chevron}
                      onClick={() => setFolderTreeExpanded(v => !v)}
                    >
                      {folderTreeExpanded
                        ? <ChevronDown size={11} />
                        : <ChevronRight size={11} />}
                    </button>
                    <span
                      className={ftStyles.rootLabel}
                      onClick={() => { setCatalogSubfolder(null); navigate('photos'); }}
                    >
                      Fotos
                    </span>
                  </div>

                  {/* Subpastas */}
                  {folderTreeExpanded && (
                    <div className={ftStyles.children}>
                      {isLoadingCatalogPhotos ? (
                        <div className={ftStyles.item} style={{ opacity: 0.6, fontStyle: 'italic' }}>
                          Carregando pastas...
                        </div>
                      ) : catalogSubfolders.length === 0 ? (
                        <div className={ftStyles.item} style={{ opacity: 0.6, fontStyle: 'italic' }}>
                          Nenhuma subpasta encontrada
                        </div>
                      ) : (
                        catalogSubfolders.map(sub => (
                          <div
                            key={sub}
                            className={`${ftStyles.item} ${catalogSubfolder === sub ? ftStyles.active : ''}`}
                            onClick={() => { setCatalogSubfolder(sub); navigate('photos'); }}
                          >
                            <Folder size={12} className={ftStyles.folderIcon} />
                            <span className={ftStyles.itemLabel}>{sub}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="nav-section">
          <div className="nav-section-title">Ferramentas</div>

          {/* Escanear */}
          <div
            className={`nav-item ${isScanning ? 'sidebar-scanning' : ''}`}
            onClick={() => { if (currentCatalog) onScanClick(); }}
            style={{ opacity: !currentCatalog ? 0.4 : 1, cursor: !currentCatalog ? 'default' : 'pointer' }}
            title={!currentCatalog ? 'Selecione um evento primeiro' : isScanning ? 'Abrir central de processamento' : 'Escanear fotos'}
          >
            {isScanning
              ? <Loader size={17} className="spin" />
              : <ScanLine size={17} />
            }
            <span>Escanear</span>
            {isScanning && <span className="sidebar-scan-badge">em andamento</span>}
          </div>

          {toolItems.map(item => (
            <div
              key={item.view}
              className={`nav-item ${activeView === item.view ? 'active' : ''}`}
              onClick={() => navigate(item.view)}
            >
              {item.icon}
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Progresso do scan (rodapé) */}
      {isScanning && (
        <div className="sidebar-scan-footer">
          <div className="sidebar-scan-progress">
            <div className="sidebar-scan-progress-fill" style={{ width: `${scanProgress}%` }} />
          </div>
          {scanMsg && <span className="sidebar-scan-msg">{scanMsg}</span>}
        </div>
      )}
    </div>
  );
}
