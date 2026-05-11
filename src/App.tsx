import { useState, useEffect, useRef } from 'react';
import {
  Image as ImageIcon,
  Users,
  UserCheck,
  Download,
  Settings,
  Scan,
  Loader,
  Search,
  ChevronDown,
  FolderOpen,
  Trash2,
} from 'lucide-react';
import { AppProvider, useApp } from './context/AppContext';
import type { ViewName } from './context/AppContext';
import { api } from './services/api';
import type { ScanStatus } from './services/api';
import CatalogModal from './components/CatalogModal';
import ScanModal from './components/ScanModal';
import PhotosView from './views/PhotosView';
import PeopleView from './views/PeopleView';
import PersonDetailView from './views/PersonDetailView';
import ReviewView from './views/ReviewView';
import ExportView from './views/ExportView';
import SettingsView from './views/SettingsView';
import './App.css';

function AppShell() {
  const { currentCatalog, catalogs, activeView, navigate, setCatalog, refreshCatalogs, bumpRefresh } = useApp();

  const [showCatalogModal, setShowCatalogModal] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const [showCatalogDropdown, setShowCatalogDropdown] = useState(false);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ name: string; catalog: string }[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  // Load catalogs on startup
  useEffect(() => {
    refreshCatalogs().then(() => {
      // If no catalog is set, open the modal
    });
  }, [refreshCatalogs]);

  // Open catalog modal when there's no catalog
  useEffect(() => {
    if (!currentCatalog && catalogs.length === 0) {
      // Wait a tick for the load to complete
      const t = setTimeout(() => setShowCatalogModal(true), 300);
      return () => clearTimeout(t);
    }
    if (!currentCatalog && catalogs.length > 0) {
      setShowCatalogModal(true);
    }
  }, [currentCatalog, catalogs.length]);

  // Scan polling
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isScanning) {
      interval = setInterval(async () => {
        const st = await api.getScanStatus().catch(() => null);
        if (!st) return;
        setScanStatus(st);
        setScanMsg(st.status_text);
        if (!st.is_scanning) {
          setIsScanning(false);
          setScanMsg(st.status_text || 'Escaneamento concluído!');
          setTimeout(() => setScanMsg(''), 4000);
          bumpRefresh();
          navigate('people');
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isScanning, bumpRefresh, navigate]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearch(false);
        setSearchResults([]);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleScanStarted = () => {
    setIsScanning(true);
    setScanMsg('Escaneamento iniciado...');
  };

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
    { view: 'photos', icon: <ImageIcon size={18} />, label: 'Catálogo' },
    { view: 'people', icon: <Users size={18} />, label: 'Identificados' },
    { view: 'review', icon: <UserCheck size={18} />, label: 'Revisão IA' },
  ];

  const toolItems: { view: ViewName; icon: React.ReactNode; label: string }[] = [
    { view: 'export', icon: <Download size={18} />, label: 'Exportador' },
    { view: 'settings', icon: <Settings size={18} />, label: 'Configurações' },
  ];

  const renderView = () => {
    switch (activeView) {
      case 'photos': return <PhotosView />;
      case 'people': return <PeopleView />;
      case 'person-detail': return <PersonDetailView />;
      case 'review': return <ReviewView />;
      case 'export': return <ExportView />;
      case 'settings': return <SettingsView />;
      default: return <PhotosView />;
    }
  };

  return (
    <div className="app-container">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="logo-icon">FP</div>
          <h2 style={{ fontSize: '1rem', fontWeight: 700 }}>Formatura PRO</h2>
        </div>

        {/* Catalog Selector */}
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
                    onClick={async () => {
                      await setCatalog(cat);
                      setShowCatalogDropdown(false);
                    }}
                  >
                    {cat}
                  </button>
                  <button
                    className="icon-btn danger"
                    style={{ flexShrink: 0, padding: '4px 6px' }}
                    title="Excluir evento"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!window.confirm(`Excluir o evento "${cat}"? Esta ação não pode ser desfeita.`)) return;
                      try {
                        await api.deleteCatalog(cat);
                        await refreshCatalogs();
                      } catch { /* ignore */ }
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

        <div className="sidebar-nav">
          <div className="nav-section">
            <div className="nav-section-title">Biblioteca</div>
            {navItems.map(item => (
              <div
                key={item.view}
                className={`nav-item ${activeView === item.view || (item.view === 'people' && activeView === 'person-detail') ? 'active' : ''}`}
                onClick={() => navigate(item.view)}
              >
                {item.icon}
                <span>{item.label}</span>
              </div>
            ))}
          </div>
          <div className="nav-section">
            <div className="nav-section-title">Ferramentas</div>
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
      </div>

      {/* Main Content */}
      <div className="main-content">
        {/* Top Bar */}
        <div className="top-bar">
          <div className="search-bar-wrap" ref={searchRef}>
            <div className="search-bar">
              <Search size={16} color="var(--text-secondary)" />
              <input
                type="text"
                placeholder="Buscar formando..."
                value={searchQuery}
                onChange={e => handleSearch(e.target.value)}
                onFocus={() => searchResults.length > 0 && setShowSearch(true)}
              />
            </div>
            {showSearch && (
              <div className="search-results-dropdown">
                {searchResults.map((r, i) => (
                  <button
                    key={i}
                    className="search-result-item"
                    onClick={() => {
                      setSearchQuery('');
                      setShowSearch(false);
                      navigate('person-detail', r.name);
                    }}
                  >
                    <Users size={14} />
                    <span>{r.name}</span>
                    <span className="result-catalog">{r.catalog}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="actions">
            {/* always rendered — avoids insertBefore crash on concurrent mount/unmount */}
            <div className="scan-status-wrap" style={{ visibility: isScanning || scanMsg ? 'visible' : 'hidden' }}>
              <div className="scan-progress-mini" style={{ opacity: isScanning && scanStatus ? 1 : 0 }}>
                <div
                  className="scan-progress-fill"
                  style={{ width: `${scanStatus?.progress ?? 0}%` }}
                />
              </div>
              <span className="scan-msg">{scanMsg}</span>
            </div>

            <button
              className="btn-primary"
              style={{ opacity: isScanning ? 0.7 : 1 }}
              onClick={() => { if (!currentCatalog) { setShowCatalogModal(true); return; } setShowScanModal(true); }}
              disabled={isScanning}
            >
              <span style={{ display: 'flex', alignItems: 'center' }}>
                <Loader size={16} className="spin" style={{ display: isScanning ? 'block' : 'none' }} />
                <Scan size={16} style={{ display: isScanning ? 'none' : 'block' }} />
              </span>
              Escanear
            </button>

            <button className="btn-primary" onClick={() => navigate('export')}>
              <Download size={16} />
              Exportar
            </button>
          </div>
        </div>

        {/* View Area */}
        <div className="view-area">
          {renderView()}
        </div>
      </div>

      {showCatalogModal && (
        <CatalogModal onClose={() => {
          if (currentCatalog) setShowCatalogModal(false);
        }} />
      )}

      {showScanModal && (
        <ScanModal
          onClose={() => setShowScanModal(false)}
          onScanStarted={handleScanStarted}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
