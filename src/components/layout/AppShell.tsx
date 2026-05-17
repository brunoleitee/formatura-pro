import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import type { ScanStatus } from '../../services/api';
import ConfirmModal from '../ConfirmModal';
import CatalogModal from '../CatalogModal';
import ScanModal from '../ScanModal';
import { ScanProcessingCenter, type ScanTimelineEntry } from '../scan/ScanProcessingCenter';
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

const CloudSyncView = lazy(() => import('../../views/CloudSyncView'));
const ScannerWorkspace = lazy(() => import('../../views/ScannerWorkspace'));

interface ScanSessionMeta {
  catalogName: string;
  oriPath: string;
  refPath: string;
  startedAt: number;
}

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

function buildTimelineEntry(
  kind: ScanTimelineEntry['kind'],
  text: string,
): ScanTimelineEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    text,
    timestamp: Date.now(),
  };
}

function isScanCompleted(status: ScanStatus | null) {
  if (!status || status.is_scanning) return false;

  const progressPct = normalizeScanProgress(status.progress);
  const statusText = (status.status_text || '').toLowerCase();
  const hasProcessedWork =
    Boolean(status.scan_summary) ||
    (status.total_processadas ?? 0) > 0 ||
    (status.total_files ?? 0) > 0;
  const countsFinished =
    (status.total_files ?? 0) > 0 &&
    (status.total_processadas ?? 0) >= (status.total_files ?? 0);
  const directCompletionText =
    statusText.includes('conclu') ||
    statusText.includes('completed') ||
    statusText.includes('done') ||
    statusText.includes('finished');
  const idleAfterCompletion =
    hasProcessedWork &&
    (statusText.includes('idle') || statusText.includes('inativo') || statusText.includes('pronto')) &&
    (Boolean(status.scan_summary) || countsFinished || progressPct >= 100);

  return hasProcessedWork && (Boolean(status.scan_summary) || countsFinished || progressPct >= 100 || directCompletionText || idleAfterCompletion);
}

export function AppShell() {
  const { currentCatalog, catalogs, activeView, refreshCatalogs, bumpRefresh, navigate } = useApp();

  const [showCatalogModal, setShowCatalogModal] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const [showScanCenter, setShowScanCenter] = useState(false);
  const [showCatalogDropdown, setShowCatalogDropdown] = useState(false);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState('');
  const [scanTimeline, setScanTimeline] = useState<ScanTimelineEntry[]>([]);
  const [scanSession, setScanSession] = useState<ScanSessionMeta | null>(null);
  const [isScanFeedPaused, setIsScanFeedPaused] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const prevScanStatusRef = useRef<ScanStatus | null>(null);
  const scanCenterDismissedRef = useRef(false);
  const activeViewPaintStartRef = useRef<number | null>(null);
  const scanCompleted = isScanCompleted(scanStatus);

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




  const appendTimeline = useCallback((entry: ScanTimelineEntry) => {
    setScanTimeline(prev => [...prev.slice(-79), entry]);
  }, []);

  const requestConfirm = useCallback((options: ConfirmDialogOptions) => {
    return new Promise<boolean>((resolve) => {
      setConfirmDialog({ ...options, resolve });
    });
  }, []);

  const syncTimelineFromStatus = useCallback((prev: ScanStatus | null, next: ScanStatus) => {
    const nextEntries: ScanTimelineEntry[] = [];
    const nextProgress = Math.round(normalizeScanProgress(next.progress));
    const prevMatches = prev?.total_matches ?? 0;
    const prevClusters = prev?.total_clusters ?? 0;
    const nextMatches = next.total_matches ?? 0;
    const nextClusters = next.total_clusters ?? 0;
    const prevRecentFaces = new Set((prev?.recent_faces ?? []).map(face => `${face.path}-${face.box.join('-')}`));

    if (!prev && next.is_scanning) {
      nextEntries.push(buildTimelineEntry('system', 'Scanner inicializado na central IA.'));
    }

    if (prev?.status_text !== next.status_text && next.status_text) {
      nextEntries.push(buildTimelineEntry('system', `${next.status_text} (${nextProgress}%)`));
    }

    if (nextMatches > prevMatches) {
      const delta = nextMatches - prevMatches;
      nextEntries.push(buildTimelineEntry('match', `${delta} match${delta !== 1 ? 'es' : ''} automátic${delta !== 1 ? 'os' : 'o'} confirmado${delta !== 1 ? 's' : ''}.`));
    }

    if (nextClusters > prevClusters) {
      const delta = nextClusters - prevClusters;
      nextEntries.push(buildTimelineEntry('cluster', `${delta} novo${delta !== 1 ? 's' : ''} cluster${delta !== 1 ? 's' : ''} criado${delta !== 1 ? 's' : ''}.`));
    }

    const newFaces = (next.recent_faces ?? []).filter((face) => {
      const faceKey = `${face.path}-${face.box.join('-')}`;
      return !prevRecentFaces.has(faceKey);
    });

    for (const face of newFaces.slice(0, prev ? 6 : 4)) {
      const isKnownMatch = Boolean(face.name) && !face.name.toLowerCase().startsWith('pessoa ');
      nextEntries.push(
        buildTimelineEntry(
          isKnownMatch ? 'match' : 'face',
          isKnownMatch ? `${face.name} vinculada automaticamente.` : `${face.name || 'Novo rosto'} entrou no lote ativo.`,
        ),
      );
    }

    if (next.gpu_error && next.gpu_error !== prev?.gpu_error) {
      nextEntries.push(buildTimelineEntry('warning', `Motor executando com fallback: ${next.gpu_error}`));
    }

    if (prev?.is_scanning && !next.is_scanning) {
      const summary = next.scan_summary;
      const totalFaces = typeof summary?.total_faces === 'number' ? summary.total_faces : undefined;
      const totalPhotos = typeof summary?.total_photos === 'number' ? summary.total_photos : next.total_processadas;
      const totalFacesLabel = totalFaces ? ` → ${totalFaces} rostos` : '';
      nextEntries.push(
        buildTimelineEntry(
          'summary',
          `Processamento concluído com ${totalPhotos ?? 0} fotos${totalFacesLabel}.`,
        ),
      );
    }

    if (nextEntries.length > 0) {
      setScanTimeline(prevEntries => [...prevEntries, ...nextEntries].slice(-80));
    }
  }, []);

  const pollScanStatus = useCallback(async () => {
    const st = await api.getScanStatus().catch(() => null);
    if (!st) return;

    const prev = prevScanStatusRef.current;
    setScanStatus(st);
    setScanMsg(st.status_text || (st.is_scanning ? 'Escaneando...' : ''));
    setIsScanning(Boolean(st.is_scanning));

    if (st.is_scanning || st.scan_summary || st.last_folder_scanned) {
      setScanSession(prevSession => ({
        catalogName:
          prevSession?.catalogName && prevSession.catalogName !== 'Evento em processamento'
            ? prevSession.catalogName
            : currentCatalog || prevSession?.catalogName || 'Evento em processamento',
        oriPath: prevSession?.oriPath || st.last_folder_scanned || '',
        refPath: prevSession?.refPath || '',
        startedAt: prevSession?.startedAt || Date.now(),
      }));
    }

    // if (st.is_scanning && (!prev || !prev.is_scanning) && !scanCenterDismissedRef.current) {
    //   setShowScanCenter(true);
    // }

    syncTimelineFromStatus(prev, st);

    if (prev?.is_scanning && !st.is_scanning) {
      scanCenterDismissedRef.current = false;
      setIsScanFeedPaused(false);
      bumpRefresh();
    }

    prevScanStatusRef.current = st;
  }, [bumpRefresh, currentCatalog, syncTimelineFromStatus]);

  useEffect(() => {
    pollScanStatus();
  }, [pollScanStatus]);

  useEffect(() => {
    if (!isScanning) return;
    const interval = setInterval(() => {
      void pollScanStatus();
    }, 1000);
    return () => clearInterval(interval);
  }, [isScanning, pollScanStatus]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void pollScanStatus();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [pollScanStatus]);

  const handleScanStarted = (meta: { catalogName: string; oriPath: string; refPath: string }) => {
    setIsScanning(true);
    setScanMsg('Escaneamento iniciado...');
    setShowScanCenter(false); // Do not show old scan center
    setIsScanFeedPaused(false);
    setScanTimeline([
      buildTimelineEntry('system', `Scanner iniciado para ${meta.catalogName}.`),
      buildTimelineEntry('system', `Origem selecionada: ${meta.oriPath}`),
    ]);
    setScanSession({
      catalogName: meta.catalogName,
      oriPath: meta.oriPath,
      refPath: meta.refPath,
      startedAt: Date.now(),
    });
    prevScanStatusRef.current = null;
    scanCenterDismissedRef.current = false;
  };

  const resetProcessingPanel = useCallback(() => {
    setScanStatus(null);
    setScanMsg('');
    setIsScanning(false);
    setScanTimeline([]);
    setScanSession(null);
    setIsScanFeedPaused(false);
    prevScanStatusRef.current = null;
  }, []);

  const handleScanClick = () => {
    if (!currentCatalog) { setShowCatalogModal(true); return; }
    navigate('scanner');
  };

  const handleCloseScanCenter = () => {
    scanCenterDismissedRef.current = true;
    setIsScanFeedPaused(false);
    setShowScanCenter(false);
  };

  const handleCancelScan = async () => {
    if (!isScanning) return;
    const confirmed = await requestConfirm({
      title: 'Descartar novo scan?',
      message: 'Iniciar um novo scan irá cancelar o processamento atual e limpar os dados em andamento.',
      confirmText: 'Iniciar novo scan',
      cancelText: 'Cancelar',
    });
    if (!confirmed) return;
    appendTimeline(buildTimelineEntry('warning', 'Solicitacao de cancelamento enviada ao scanner.'));
    setScanMsg('Cancelando scan...');
    try {
      await api.stopScan();
      await pollScanStatus();
    } catch {
      appendTimeline(buildTimelineEntry('warning', 'Não foi possível cancelar o scanner agora.'));
    }
  };

  const handleOpenReview = () => {
    setIsScanFeedPaused(false);
    setShowScanCenter(false);
    scanCenterDismissedRef.current = false;
    navigate('review');
  };

  const handleNewScan = () => {
    resetProcessingPanel();
    scanCenterDismissedRef.current = false;
    setShowScanCenter(false);
    setShowScanModal(true);
  };

  const canOpenReview = Boolean(scanStatus?.scan_summary) || (scanStatus?.total_clusters ?? 0) > 0;

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
    if (!currentCatalog && !showScanCenter) {
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
      case 'cloud-sync':     return <Suspense fallback={<div style={{padding:40,color:'#9ca3af'}}>Carregando...</div>}><CloudSyncView /></Suspense>;
      case 'scanner':        return <ScannerWorkspace />;
      case 'catalog-settings': return <CatalogSettingsView />;
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
