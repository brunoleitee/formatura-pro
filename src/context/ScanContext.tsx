import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { api } from '../services/api';
import type { ScanStatus } from '../services/api';
import { useApp } from './AppContext';

export interface ScanTimelineEntry {
  id: string;
  kind: 'system' | 'match' | 'cluster' | 'face' | 'warning' | 'summary';
  text: string;
  timestamp: number;
}

export interface ScanSessionMeta {
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

interface ScanContextValue {
  scanStatus: ScanStatus | null;
  isScanning: boolean;
  scanMsg: string;
  scanTimeline: ScanTimelineEntry[];
  scanSession: ScanSessionMeta | null;
  resetProcessingPanel: () => void;
  pollScanStatus: () => Promise<void>;
  handleScanStarted: (meta: { catalogName: string; oriPath: string; refPath: string }) => void;
  handleCancelScan: (confirmFn?: () => Promise<boolean>) => Promise<void>;
  appendTimeline: (entry: ScanTimelineEntry) => void;
}

const ScanContext = createContext<ScanContextValue | null>(null);

export function ScanProvider({ children }: { children: ReactNode }) {
  const { currentCatalog, bumpRefresh } = useApp();

  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState('');
  const [scanTimeline, setScanTimeline] = useState<ScanTimelineEntry[]>([]);
  const [scanSession, setScanSession] = useState<ScanSessionMeta | null>(null);
  const prevScanStatusRef = useRef<ScanStatus | null>(null);
  const scanCenterDismissedRef = useRef(false);

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

    syncTimelineFromStatus(prev, st);

    if (prev?.is_scanning && !st.is_scanning) {
      scanCenterDismissedRef.current = false;
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

  const handleScanStarted = useCallback((meta: { catalogName: string; oriPath: string; refPath: string }) => {
    setIsScanning(true);
    setScanMsg('Escaneamento iniciado...');
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
  }, []);

  const resetProcessingPanel = useCallback(() => {
    setScanStatus(null);
    setScanMsg('');
    setIsScanning(false);
    setScanTimeline([]);
    setScanSession(null);
    prevScanStatusRef.current = null;
  }, []);

  const handleCancelScan = useCallback(async (confirmFn?: () => Promise<boolean>) => {
    if (!isScanning) return;
    if (confirmFn) {
      const confirmed = await confirmFn();
      if (!confirmed) return;
    }
    appendTimeline(buildTimelineEntry('warning', 'Solicitacao de cancelamento enviada ao scanner.'));
    setScanMsg('Cancelando scan...');
    try {
      await api.stopScan();
      await pollScanStatus();
    } catch {
      appendTimeline(buildTimelineEntry('warning', 'Não foi possível cancelar o scanner agora.'));
    }
  }, [isScanning, appendTimeline, pollScanStatus]);

  return (
    <ScanContext.Provider value={{
      scanStatus,
      isScanning,
      scanMsg,
      scanTimeline,
      scanSession,
      resetProcessingPanel,
      pollScanStatus,
      handleScanStarted,
      handleCancelScan,
      appendTimeline,
    }}>
      {children}
    </ScanContext.Provider>
  );
}

export function useScan() {
  const ctx = useContext(ScanContext);
  if (!ctx) throw new Error('useScan must be inside ScanProvider');
  return ctx;
}
