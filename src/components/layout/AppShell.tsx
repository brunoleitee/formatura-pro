import { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import type { ScanStatus } from '../../services/api';
import CatalogModal from '../CatalogModal';
import ScanModal from '../ScanModal';
import CatalogView from '../../views/CatalogView';
import PeopleView from '../../views/PeopleView';
import PersonDetailView from '../../views/PersonDetailView';
import ReviewView from '../../views/ReviewView';
import ExportView from '../../views/ExportView';
import SettingsView from '../../views/SettingsView';
import { Sidebar } from './Sidebar';

export function AppShell() {
  const { currentCatalog, catalogs, activeView, refreshCatalogs, bumpRefresh, navigate } = useApp();

  const [showCatalogModal, setShowCatalogModal] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const [showCatalogDropdown, setShowCatalogDropdown] = useState(false);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState('');

  useEffect(() => {
    refreshCatalogs();
  }, [refreshCatalogs]);

  useEffect(() => {
    if (!currentCatalog && catalogs.length === 0) {
      const t = setTimeout(() => setShowCatalogModal(true), 300);
      return () => clearTimeout(t);
    }
    if (!currentCatalog && catalogs.length > 0) {
      setShowCatalogModal(true);
    }
  }, [currentCatalog, catalogs.length]);

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

  const handleScanStarted = () => {
    setIsScanning(true);
    setScanMsg('Escaneamento iniciado...');
  };

  const handleScanClick = () => {
    if (!currentCatalog) { setShowCatalogModal(true); return; }
    setShowScanModal(true);
  };

  const renderView = () => {
    switch (activeView) {
      case 'photos':        return <CatalogView />;
      case 'people':        return <PeopleView />;
      case 'person-detail': return <PersonDetailView />;
      case 'review':        return <ReviewView />;
      case 'export':        return <ExportView />;
      case 'settings':      return <SettingsView />;
      default:              return <CatalogView />;
    }
  };

  return (
    <div className="app-container">
      <Sidebar
        showCatalogDropdown={showCatalogDropdown}
        setShowCatalogDropdown={setShowCatalogDropdown}
        setShowCatalogModal={setShowCatalogModal}
        onScanClick={handleScanClick}
        isScanning={isScanning}
        scanMsg={scanMsg}
        scanProgress={scanStatus?.progress ?? 0}
      />
      <div className="main-content">
        <div className="view-area">
          {renderView()}
        </div>
      </div>
      {showCatalogModal && (
        <CatalogModal onClose={() => { if (currentCatalog) setShowCatalogModal(false); }} />
      )}
      {showScanModal && (
        <ScanModal onClose={() => setShowScanModal(false)} onScanStarted={handleScanStarted} />
      )}
    </div>
  );
}
