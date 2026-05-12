import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import type { ScanStatus } from '../../services/api';
import CatalogModal from '../CatalogModal';
import ScanModal from '../ScanModal';
import { ScanProcessingCenter, type ScanTimelineEntry } from '../scan/ScanProcessingCenter';
import CatalogView from '../../views/CatalogView';
import PeopleView from '../../views/PeopleView';
import PersonDetailView from '../../views/PersonDetailView';
import ReviewView from '../../views/ReviewView';
import ExportView from '../../views/ExportView';
import SettingsView from '../../views/SettingsView';
import { Sidebar } from './Sidebar';

interface ScanSessionMeta {
  catalogName: string;
  oriPath: string;
  refPath: string;
  startedAt: number;
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
  const prevScanStatusRef = useRef<ScanStatus | null>(null);
  const scanCenterDismissedRef = useRef(false);

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

  const appendTimeline = useCallback((entry: ScanTimelineEntry) => {
    setScanTimeline(prev => [...prev.slice(-79), entry]);
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
      const totalFacesLabel = totalFaces ? ` • ${totalFaces} rostos` : '';
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

    if (st.is_scanning && (!prev || !prev.is_scanning) && !scanCenterDismissedRef.current) {
      setShowScanCenter(true);
    }

    syncTimelineFromStatus(prev, st);

    if (prev?.is_scanning && !st.is_scanning) {
      scanCenterDismissedRef.current = false;
      setIsScanFeedPaused(false);
      bumpRefresh();
      navigate('people');
    }

    prevScanStatusRef.current = st;
  }, [bumpRefresh, currentCatalog, navigate, syncTimelineFromStatus]);

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

  const handleScanClick = () => {
    if (!currentCatalog) { setShowCatalogModal(true); return; }
    if (isScanning || scanStatus?.scan_summary) {
      scanCenterDismissedRef.current = false;
      setShowScanCenter(true);
      return;
    }
    setShowScanModal(true);
  };

  const handleCloseScanCenter = () => {
    scanCenterDismissedRef.current = true;
    setShowScanCenter(false);
  };

  const handleCancelScan = async () => {
    if (!isScanning) return;
    if (!window.confirm('Cancelar o scanner atual? O processamento em andamento será interrompido.')) return;
    appendTimeline(buildTimelineEntry('warning', 'Solicitação de cancelamento enviada ao scanner.'));
    setScanMsg('Cancelando scan...');
    try {
      await api.stopScan();
      await pollScanStatus();
    } catch {
      appendTimeline(buildTimelineEntry('warning', 'Não foi possível cancelar o scanner agora.'));
    }
  };

  const handleOpenReview = () => {
    setShowScanCenter(false);
    scanCenterDismissedRef.current = false;
    navigate('review');
  };

  const canOpenReview = Boolean(scanStatus?.scan_summary) || (scanStatus?.total_clusters ?? 0) > 0;

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
        scanProgress={normalizeScanProgress(scanStatus?.progress)}
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
              onToggleFeedPaused={() => setIsScanFeedPaused(prev => !prev)}
              onCancel={handleCancelScan}
              onClose={handleCloseScanCenter}
              onOpenReview={handleOpenReview}
              canOpenReview={canOpenReview}
            />
          ) : (
            renderView()
          )}
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
