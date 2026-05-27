import { useState, useEffect, useCallback, useRef } from 'react';
import { api, type ScanStatus } from '../services/api';

interface TimelineEntry {
  id: string;
  kind: 'system' | 'face' | 'match' | 'cluster' | 'summary' | 'warning' | 'error';
  text: string;
  timestamp: number;
}

interface ScannerState {
  scanStatus: ScanStatus | null;
  isScanning: boolean;
  isCompleted: boolean;
  polling: boolean;
  timeline: TimelineEntry[];
  processedPhotos: string[];
  activePhotoIndex: number;
  elapsedSeconds: number;
  systemMetrics: {
    cpuPercent: number | null;
    ramUsedGb: number | null;
    ramPercent: number | null;
    gpuPercent: number | null;
    temperatureC: number | null;
    cpuTemperatureC: number | null;
  } | null;
  completeStats: { photos: number; faces: number; time: string };
  showCompleteModal: boolean;
}

export function useScanner() {
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [polling, setPolling] = useState(false);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [processedPhotos, setProcessedPhotos] = useState<string[]>([]);
  const [activePhotoIndex, setActivePhotoIndex] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [systemMetrics, setSystemMetrics] = useState<ScannerState['systemMetrics']>(null);
  const [completeStats, setCompleteStats] = useState({ photos: 0, faces: 0, time: '' });
  const [showCompleteModal, setShowCompleteModal] = useState(false);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metricsPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingWasScanningRef = useRef(false);
  const userNavigatedRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const isScanningRef = useRef(false);

  useEffect(() => {
    if (scanStatus?.started_at) startedAtRef.current = scanStatus.started_at;
  }, [scanStatus?.started_at]);

  useEffect(() => {
    if (!isScanning || !startedAtRef.current) {
      setElapsedSeconds(0);
      return;
    }
    const tick = () => {
      if (startedAtRef.current) setElapsedSeconds(Math.floor(Date.now() / 1000 - startedAtRef.current));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isScanning]);

  const startPolling = useCallback(() => {
    setPolling(true);
    let pollDelay = 1000;
    let pollFails = 0;
    const MAX_POLL_FAILS = 20;
    const poll = async () => {
      try {
        const st = await api.getScanStatus();
        pollFails = 0;
        pollDelay = 1000;
        setScanStatus(st);

        if (st.is_scanning) {
          setIsScanning(true);
          isScanningRef.current = true;
          pollingWasScanningRef.current = true;

          if (st.current_photo?.path) {
            const photoPath = st.current_photo.path;
            setProcessedPhotos(prev =>
              prev.includes(photoPath) ? prev : [photoPath, ...prev].slice(0, 100)
            );
            if (!userNavigatedRef.current) {
              setActivePhotoIndex(0);
            }
          }

          if (Math.random() > 0.8 && st.current_photo?.name) {
            setTimeline(prev => [
              ...prev.slice(-49),
              { id: Date.now().toString(), kind: 'system', text: `Processando: ${st.current_photo.name}...`, timestamp: Date.now() }
            ]);
          }
        }

        if (!st.is_scanning && pollingWasScanningRef.current) {
          pollingWasScanningRef.current = false;
          setIsScanning(false);
          isScanningRef.current = false;
          setPolling(false);
          setActivePhotoIndex(0);
          userNavigatedRef.current = false;
          if (pollRef.current) clearTimeout(pollRef.current);
          if (st.stopped) {
            setIsCompleted(false);
            setTimeline(prev => [...prev, { id: `stopped-${Date.now()}`, kind: 'warning', text: 'Escaneamento interrompido.', timestamp: Date.now() }]);
          } else {
            setIsCompleted(true);
            setTimeline(prev => [...prev, { id: `end-${Date.now()}`, kind: 'summary', text: 'Escaneamento finalizado.', timestamp: Date.now() }]);
            setCompleteStats({
              photos: st.total_processadas || st.scan_summary?.total_photos || 0,
              faces: st.total_faces || st.scan_summary?.total_faces || 0,
              time: st.scan_summary?.time_str || '',
            });
            setShowCompleteModal(true);
          }
        }
      } catch {
        pollFails++;
        if (pollFails === 3) {
          setTimeline(prev => [...prev.slice(-49), { id: `poll-warn-${Date.now()}`, kind: 'warning', text: 'Perdendo conexão com o servidor...', timestamp: Date.now() }]);
        }
        if (pollFails >= MAX_POLL_FAILS) {
          setPolling(false);
          setTimeline(prev => [...prev.slice(-49), { id: `poll-err-${Date.now()}`, kind: 'error', text: 'Não foi possível continuar monitorando o scan.', timestamp: Date.now() }]);
          return;
        }
        pollDelay = Math.min(pollDelay * 1.5, 15000);
      }
      if (pollingWasScanningRef.current) {
        pollRef.current = setTimeout(poll, pollDelay);
      }
    };
    poll();
  }, []);

  useEffect(() => {
    let metricsDelay = 2000;
    let metricsFails = 0;
    const MAX_METRICS_FAILS = 3;
    let metricsActive = true;
    const pollMetrics = async () => {
      if (!metricsActive) return;
      try {
        const m: any = await api.getSystemMetrics();
        metricsFails = 0;
        metricsDelay = 2000;
        setSystemMetrics(m);
      } catch (err) {
        metricsFails++;
        if (metricsFails >= MAX_METRICS_FAILS) {
          metricsActive = false;
          return;
        }
        if (metricsFails === 1) {
          setTimeline(prev => [...prev.slice(-49), {
            id: `metrics-err-${Date.now()}`,
            kind: 'error',
            text: `Erro ao buscar métricas: ${err instanceof Error ? err.message : 'desconhecido'}`,
            timestamp: Date.now()
          }]);
        }
        metricsDelay = Math.min(metricsDelay * 2, 30000);
      }
      if (metricsActive) metricsPollRef.current = setTimeout(pollMetrics, metricsDelay);
    };
    pollMetrics();
    return () => { metricsActive = false; if (metricsPollRef.current) clearTimeout(metricsPollRef.current); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getScanStatus().then(st => {
      if (cancelled) return;
      if (st.is_scanning) {
        setIsScanning(true);
        isScanningRef.current = true;
        setScanStatus(st);
        startPolling();
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [startPolling]);

  const stopScan = useCallback(async () => {
    try {
      await api.stopScan();
      setIsScanning(false);
      isScanningRef.current = false;
      setPolling(false);
      setTimeline(prev => [...prev, { id: `stop-${Date.now()}`, kind: 'warning', text: 'Parando escaneamento...', timestamp: Date.now() }]);
    } catch (err) {
      console.error('Erro ao parar scan:', err);
    }
  }, []);

  const clearCompleted = useCallback(() => {
    setShowCompleteModal(false);
    setIsCompleted(false);
  }, []);

  return {
    scanStatus, isScanning, isCompleted, polling, timeline, processedPhotos,
    activePhotoIndex, setActivePhotoIndex, elapsedSeconds, systemMetrics,
    completeStats, showCompleteModal,
    userNavigatedRef, isScanningRef, pollRef,
    startPolling, stopScan, clearCompleted,
    setActivePhotoIndex: setActivePhotoIndex as React.Dispatch<React.SetStateAction<number>>,
    setProcessedPhotos: setProcessedPhotos as React.Dispatch<React.SetStateAction<string[]>>,
    setPolling, setScanStatus, setIsScanning, setTimeline, setShowCompleteModal,
  };
}
