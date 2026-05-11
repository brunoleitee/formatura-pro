import { Search, Users, Loader, Scan, Download } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { ScanStatus } from '../../services/api';

interface TopBarProps {
  searchRef: React.RefObject<HTMLDivElement>;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  handleSearch: (q: string) => void;
  showSearch: boolean;
  setShowSearch: (s: boolean) => void;
  searchResults: { name: string; catalog: string }[];
  isScanning: boolean;
  scanMsg: string;
  scanStatus: ScanStatus | null;
  setShowScanModal: (s: boolean) => void;
  setShowCatalogModal: (s: boolean) => void;
  showGlobalActions?: boolean;
}

export function TopBar({
  searchRef,
  searchQuery,
  setSearchQuery,
  handleSearch,
  showSearch,
  setShowSearch,
  searchResults,
  isScanning,
  scanMsg,
  scanStatus,
  setShowScanModal,
  setShowCatalogModal,
  showGlobalActions = true,
}: TopBarProps) {
  const { currentCatalog, navigate } = useApp();

  return (
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
        {showGlobalActions && (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
