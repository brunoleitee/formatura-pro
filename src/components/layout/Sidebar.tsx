import { FolderOpen, ChevronDown, Trash2, Image as ImageIcon, Users, UserCheck, Download, Settings } from 'lucide-react';
import { useApp, type ViewName } from '../../context/AppContext';
import { api } from '../../services/api';

interface SidebarProps {
  showCatalogDropdown: boolean;
  setShowCatalogDropdown: React.Dispatch<React.SetStateAction<boolean>>;
  setShowCatalogModal: React.Dispatch<React.SetStateAction<boolean>>;
}

export function Sidebar({ showCatalogDropdown, setShowCatalogDropdown, setShowCatalogModal }: SidebarProps) {
  const { currentCatalog, catalogs, activeView, navigate, setCatalog, refreshCatalogs } = useApp();

  const navItems: { view: ViewName; icon: React.ReactNode; label: string }[] = [
    { view: 'photos', icon: <ImageIcon size={18} />, label: 'Catálogo' },
    { view: 'people', icon: <Users size={18} />, label: 'Identificados' },
    { view: 'review', icon: <UserCheck size={18} />, label: 'Revisão IA' },
  ];

  const toolItems: { view: ViewName; icon: React.ReactNode; label: string }[] = [
    { view: 'export', icon: <Download size={18} />, label: 'Exportador' },
    { view: 'settings', icon: <Settings size={18} />, label: 'Configurações' },
  ];

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="logo-icon">FP</div>
        <h2 style={{ fontSize: '1rem', fontWeight: 700 }}>Formatura PRO</h2>
      </div>

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
  );
}
