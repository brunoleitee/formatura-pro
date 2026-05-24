import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useScan } from '../../context/ScanContext';
import { api } from '../../services/api';
import ConfirmModal from '../ConfirmModal';
import CatalogModal from '../CatalogModal';
import ScanModal from '../ScanModal';
import CatalogView from '../../views/CatalogView';
import DashboardView from '../../views/DashboardView';
import PeopleView from '../../views/PeopleView';
import PersonDetailView from '../../views/PersonDetailView';
import ReviewView from '../../views/ReviewView';
import ExportView from '../../views/ExportView';
import SettingsView from '../../views/SettingsView';
import CatalogSettingsView from '../../views/CatalogSettingsView';
import { Sidebar } from './Sidebar';
import { logPerf, perfNow } from '../../utils/perf';
import { lazy, Suspense } from 'react';

const ScannerWorkspace = lazy(() => import('../../views/ScannerWorkspace'));

interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
}

interface ConfirmDialogState extends ConfirmDialogOptions {
  resolve: (confirmed: boolean) => void;
}

function normalizeScanProgress(progress: number | undefined) {
  if (!Number.isFinite(progress)) return 0;
  const value = Number(progress);
  return Math.max(0, Math.min(100, value <= 1 ? value * 100 : value));
}

export function AppShell() {
  const { currentCatalog, activeView, refreshCatalogs, navigate } = useApp();
  const { scanStatus, isScanning, scanMsg, handleScanStarted } = useScan();

  const [showCatalogModal, setShowCatalogModal] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const [showCatalogDropdown, setShowCatalogDropdown] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const activeViewPaintStartRef = useRef<number | null>(null);

  useEffect(() => {
    refreshCatalogs();
  }, [refreshCatalogs]);

  useEffect(() => {
    activeViewPaintStartRef.current = perfNow();
    const raf = window.requestAnimationFrame(() => {
      if (activeViewPaintStartRef.current !== null) {
        logPerf(`tab ${activeView}`, activeViewPaintStartRef.current);
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [activeView]);

  const requestConfirm = useCallback((options: ConfirmDialogOptions) => {
    return new Promise<boolean>((resolve) => {
      setConfirmDialog({ ...options, resolve });
    });
  }, []);

  const handleScanClick = () => {
    if (!currentCatalog) { setShowCatalogModal(true); return; }
    navigate('scanner');
  };

  function autoCatalogName(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `Catalogo_${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  }

  const handleQuickCreate = async () => {
    const name = autoCatalogName();
    try {
      await api.setCatalog(name);
      await refreshCatalogs();
    } catch (e) {
      console.error('Erro ao criar catálogo rápido:', e);
    }
  };

  const renderEmptyCatalog = () => (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: '16px', padding: '40px', color: '#94a3b8', textAlign: 'center',
    }}>
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
      <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 600, color: '#e2e8f0' }}>Nenhum catálogo aberto</h2>
      <p style={{ margin: 0, fontSize: '0.85rem', maxWidth: 360, lineHeight: 1.5 }}>
        Crie ou selecione um catálogo para começar a gerenciar suas fotos.
      </p>
      <div style={{ display: 'flex', gap: '10px', marginTop: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          onClick={handleQuickCreate}
          style={{
            padding: '10px 22px', borderRadius: '10px', border: 'none',
            background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
            color: '#fff', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
            transition: 'box-shadow 0.2s',
            boxShadow: '0 4px 14px rgba(59,130,246,0.35)',
          }}
          onMouseEnter={(e) => e.currentTarget.style.boxShadow = '0 6px 20px rgba(59,130,246,0.5)'}
          onMouseLeave={(e) => e.currentTarget.style.boxShadow = '0 4px 14px rgba(59,130,246,0.35)'}
        >
          Criar catálogo rápido
        </button>
        <button
          onClick={() => setShowCatalogModal(true)}
          style={{
            padding: '10px 22px', borderRadius: '10px', border: '1px solid rgba(148,163,184,0.2)',
            background: 'transparent', color: '#cbd5e1', fontWeight: 500, fontSize: '0.85rem',
            cursor: 'pointer', transition: 'background 0.2s',
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(148,163,184,0.08)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          Gerenciar catálogos
        </button>
      </div>
    </div>
  );

  const renderView = () => {
    if (!currentCatalog && activeView !== 'settings') {
      return renderEmptyCatalog();
    }
    switch (activeView) {
      case 'dashboard':    return <DashboardView />;
      case 'photos':        return <CatalogView />;
      case 'people':        return <PeopleView onRequestConfirm={requestConfirm} />;
      case 'person-detail': return <PersonDetailView />;
      case 'review':        return <ReviewView />;
      case 'export':        return <ExportView />;
      case 'settings':      return <SettingsView />;
      case 'scanner':        return <ScannerWorkspace />;
      case 'catalog-settings': return <CatalogSettingsView onRequestConfirm={requestConfirm} />;
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
        scanProgress={normalizeScanProgress(scanStatus?.progress)}
        onRequestConfirm={requestConfirm}
      />
      <div className="main-content">
        <div className="view-area">
          {renderView()}
        </div>
      </div>
      {showCatalogModal && (
        <CatalogModal
          onClose={() => setShowCatalogModal(false)}
          onRequestConfirm={requestConfirm}
        />
      )}
      {showScanModal && (
        <ScanModal onClose={() => setShowScanModal(false)} onScanStarted={handleScanStarted} />
      )}
      <ConfirmModal
        open={Boolean(confirmDialog)}
        title={confirmDialog?.title || ''}
        message={confirmDialog?.message || ''}
        confirmText={confirmDialog?.confirmText || 'Confirmar'}
        cancelText={confirmDialog?.cancelText || 'Cancelar'}
        onConfirm={() => {
          const resolve = confirmDialog?.resolve;
          setConfirmDialog(null);
          resolve?.(true);
        }}
        onCancel={() => {
          const resolve = confirmDialog?.resolve;
          setConfirmDialog(null);
          resolve?.(false);
        }}
      />
    </div>
  );
}
