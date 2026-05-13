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
import { Sidebar } from './Sidebar';
import { logPerf, perfNow } from '../../utils/perf';

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

  useEffect(() => {
    if (!currentCatalog && catalogs.length === 0) {
      const t = setTimeout(() => setShowCatalogModal(true), 300);
      return () => clearTimeout(t);
    }
    if (!currentCatalog && catalogs.length > 0) {
      setShowCatalogModal(true);
    }
  }, [currentCatalog, catalogs.length]);

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
      nextEntries.push(buildTimelineEntry('match', `${delta} match${delta !== 1 ? 'es' : ''} automÃ¡tic${delta !== 1 ? 'os' : 'o'} confirmado${delta !== 1 ? 's' : ''}.`));
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
      const totalFacesLabel = totalFaces ? ` â€¢ ${totalFaces} rostos` : '';
      nextEntries.push(
        buildTimelineEntry(
          'summary',
          `Processamento concluÃ­do com ${totalPhotos ?? 0} fotos${totalFacesLabel}.`,
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

    if (st.is_scanning && (!prev || !prev.is_scanning) && !scanCenterDismissedRef.current) {
      setShowScanCenter(true);
    }

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
    setShowScanCenter(true);
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
    if (isScanning) {
      scanCenterDismissedRef.current = false;
      setShowScanCenter(true);
      return;
    }
    setShowScanModal(true);
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
    appendTimeline(buildTimelineEntry('warning', 'SolicitaÃ§Ã£o de cancelamento enviada ao scanner.'));
    setScanMsg('Cancelando scan...');
    try {
      await api.stopScan();
      await pollScanStatus();
    } catch {
      appendTimeline(buildTimelineEntry('warning', 'NÃ£o foi possÃ­vel cancelar o scanner agora.'));
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

  const renderView = () => {
    switch (activeView) {
      case 'dashboard':    return <DashboardView />;
      case 'photos':        return <CatalogView />;
      case 'people':        return <PeopleView onRequestConfirm={requestConfirm} />;
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
        scanProgress={normalizeScanProgress(scanStatus?.progress)}
        onRequestConfirm={requestConfirm}
      />
      <div className="main-content">
        <div className="view-area">
          {showScanCenter ? (
            <ScanProcessingCenter
              currentCatalog={scanSession?.catalogName || currentCatalog}
              scanStatus={scanStatus}
              scanMsg={scanMsg}
              isScanning={isScanning}
              timeline={scanTimeline}
              sourcePath={scanSession?.oriPath || scanStatus?.last_folder_scanned}
              isFeedPaused={isScanFeedPaused}
              isCompleted={scanCompleted}
              onToggleFeedPaused={() => setIsScanFeedPaused(prev => !prev)}
              onCancel={handleCancelScan}
              onClose={handleCloseScanCenter}
              onOpenReview={handleOpenReview}
              onNewScan={handleNewScan}
              canOpenReview={canOpenReview}
            />
          ) : (
            renderView()
          )}
        </div>
      </div>
      {showCatalogModal && (
        <CatalogModal
          onClose={() => { if (currentCatalog) setShowCatalogModal(false); }}
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
