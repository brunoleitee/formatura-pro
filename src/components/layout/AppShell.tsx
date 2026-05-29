import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useScan, normalizeScanProgress } from '../../context/ScanContext';
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
import { autoCatalogName } from '../../utils/catalogUtils';
import { lazy } from 'react';

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

export function AppShell() {
  const { currentCatalog, activeView, refreshCatalogs, navigate, isBackendOnline } = useApp();
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
          onClick={() => {
            setShowCatalogModal(true);
            setTimeout(() => {
              const input = document.querySelector('.modal-create input') as HTMLInputElement;
              if (input) input.focus();
            }, 80);
          }}
          style={{
            padding: '10px 22px', borderRadius: '10px', border: 'none',
            background: 'var(--accent)',
            color: 'var(--bg-primary, #000)', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer',
            transition: 'all 0.2s',
            boxShadow: '0 4px 14px var(--accent-glow)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--accent-hover)';
            e.currentTarget.style.boxShadow = '0 6px 20px var(--accent-glow)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--accent)';
            e.currentTarget.style.boxShadow = '0 4px 14px var(--accent-glow)';
          }}
        >
          Criar catálogo
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
      {!isBackendOnline && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(15, 17, 26, 0.82)',
          backdropFilter: 'blur(12px)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          zIndex: 9999,
          color: '#f1f5f9',
          fontFamily: 'Inter, system-ui, sans-serif',
        }}>
          <style>{`
            @keyframes spin-rotate {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
            .connection-spin {
              animation: spin-rotate 1.5s linear infinite;
            }
            @keyframes status-pulse {
              0%, 100% { opacity: 0.4; }
              50% { opacity: 1; }
            }
            .connection-pulse {
              animation: status-pulse 1.8s ease-in-out infinite;
            }
          `}</style>
          <div style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-strong)',
            padding: '40px',
            borderRadius: 'var(--radius-xl)',
            boxShadow: 'var(--shadow-modal)',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            maxWidth: '380px',
            textAlign: 'center',
            gap: '20px',
          }}>
            <div style={{
              width: '56px', height: '56px',
              borderRadius: '50%',
              background: 'var(--bg-active)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <LoaderCircle size={26} className="connection-spin" style={{ color: 'var(--accent)' }} />
            </div>
            <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 600, color: 'var(--text-primary)' }}>Conectando ao Servidor...</h2>
            <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              A conexão com o servidor local do Formatura PRO foi interrompida ou o serviço está iniciando. Aguardando reconexão automática...
            </p>
            <div style={{
              fontSize: '0.74rem',
              color: 'var(--text-muted)',
              display: 'flex', alignItems: 'center', gap: '6px',
              marginTop: '4px',
            }}>
              <div className="connection-pulse" style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--warning)' }}></div>
              <span>Tentando restabelecer porta local...</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
