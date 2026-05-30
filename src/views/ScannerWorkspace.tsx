import { useState, useEffect, useCallback, useRef, memo, useMemo } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { 
  X, Cpu, ScanFace, ScanLine,
  Maximize2, LayoutGrid, Search, AlertTriangle,
  CheckCircle2, Terminal, Zap, Gauge, Activity, Calendar,
  Play, Pause, Folder, LoaderCircle, List, SlidersHorizontal,
  HardDrive, Monitor, ChevronRight as ChevronRightIcon, ChevronLeft,
  Image as ImageIcon, Users2
} from 'lucide-react';
import { api, catalogApi, type ExplorerPhoto } from '../services/api';
import { useApp } from '../context/AppContext';
import { useScan } from '../context/ScanContext';
import { ScanCompleteModal } from '../components/ScanCompleteModal';
import CircularGauge from '../components/scanner/CircularGauge';
import ScannerPhotoCard from '../components/scanner/ScannerPhotoCard';
import styles from './ScannerWorkspace.module.css';

interface TimelineEntry {
  id: string;
  kind: 'system' | 'face' | 'match' | 'cluster' | 'summary' | 'warning' | 'error';
  text: string;
  timestamp: number;
}

interface SelectedPhotoFaceItem {
  id: string;
  thumbnail: string;
  suggestedName: string;
  confidence: number;
  badge: 'ia' | 'similar' | 'sem_match';
}



const ScannerWorkspace = memo(function ScannerWorkspace() {
  const { setCatalog, refreshCatalogs, currentCatalog, navigate, pendingScanConfig, setPendingScanConfig } = useApp();
  const { 
    scanStatus, 
    isScanning, 
    scanTimeline: timeline, 
    pollScanStatus, 
    handleScanStarted,
    handleCancelScan,
    resetProcessingPanel
  } = useScan();

  const [eventPath, setEventPath] = useState('');
  const [refPath, setRefPath] = useState('');
  const [refPathInfo, setRefPathInfo] = useState<{ photos: number; subfolders: number } | null>(null);
  const [eventPathInfo, setEventPathInfo] = useState<{ photos: number; subfolders: number } | null>(null);
  const [catalogName, setCatalogName] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [isFeedPaused, setIsFeedPaused] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [showSetup, setShowSetup] = useState(true);

  // Subpastas de eventos selecionadas granularmente
  const [eventSubfolders, setEventSubfolders] = useState<Array<{ name: string; path: string; totalFiles: number }>>([]);
  const [selectedSubfolders, setSelectedSubfolders] = useState<string[]>([]);
  const [loadingSubfolders, setLoadingSubfolders] = useState(false);

  // Carrega subpastas físicas imediatas da pasta de eventos selecionada
  useEffect(() => {
    if (eventPath) {
      setLoadingSubfolders(true);
      api.exploreTree(eventPath, 1)
        .then(res => {
          if (res && res.ok && Array.isArray(res.children)) {
            const subs = res.children
              .filter((c: any) => c.type === 'folder')
              .map((c: any) => ({
                name: c.name,
                path: c.path,
                totalFiles: c.total_files || 0
              }));
            setEventSubfolders(subs);
            setSelectedSubfolders(subs.map(s => s.path));
            
            const totalPhotos = res.total_photos || res.total_files || 0;
            const subfoldersCount = subs.length;
            setEventPathInfo({ photos: totalPhotos, subfolders: subfoldersCount });
          } else {
            setEventSubfolders([]);
            setSelectedSubfolders([]);
            setEventPathInfo(null);
          }
        })
        .catch(() => {
          setEventSubfolders([]);
          setSelectedSubfolders([]);
          setEventPathInfo(null);
        })
        .finally(() => {
          setLoadingSubfolders(false);
        });
    } else {
      setEventSubfolders([]);
      setSelectedSubfolders([]);
      setEventPathInfo(null);
    }
  }, [eventPath]);

  // Fecha o setup assim que o scanner inicia ou se já estiver rodando
  useEffect(() => {
    if (isScanning) {
      setShowSetup(false);
    }
  }, [isScanning]);

  // Sincroniza o nome do catálogo inicial e carrega as pastas já vinculadas do catálogo
  useEffect(() => {
    if (currentCatalog) {
      setCatalogName(currentCatalog);
      
      catalogApi.listFolders(currentCatalog)
        .then(res => {
          const folders = res.folders || [];
          if (Array.isArray(folders)) {
            const eventFolder = folders.find(f => f.folder_type === 'event' || f.folderType === 'event');
            const refFolder = folders.find(f => f.folder_type === 'reference' || f.folderType === 'reference');
            
            let foundEvent = '';
            let foundRef = '';

            if (eventFolder?.path) {
              foundEvent = eventFolder.path;
              setEventPath(eventFolder.path);
              setEventFolders(prev => {
                if (!prev.includes(eventFolder.path)) {
                  return [...prev, eventFolder.path];
                }
                return prev;
              });
            }
            if (refFolder?.path) {
              foundRef = refFolder.path;
              setRefPath(refFolder.path);
              // Tenta buscar informações extras da pasta de referência de forma assíncrona
              Promise.all([
                api.explorePhotos(refFolder.path, { recursive: true, limit: 0, include_raw: true }),
                api.exploreTree(refFolder.path, 1)
              ]).then(([photosRes, treeRes]) => {
                const subCount = treeRes && treeRes.ok && Array.isArray(treeRes.children)
                  ? treeRes.children.filter((c: any) => c.type === 'folder').length
                  : 0;
                setRefPathInfo({
                  photos: photosRes.total || 0,
                  subfolders: subCount,
                });
              }).catch(() => {
                api.explorePhotos(refFolder.path, { recursive: true, limit: 0, include_raw: true })
                  .then(photosRes => {
                    setRefPathInfo({
                      photos: photosRes.total || 0,
                      subfolders: 0,
                    });
                  }).catch(() => null);
              });
            }
          }
        })
        .catch(err => {
          console.warn('[ScannerWorkspace] falha ao carregar pastas salvas:', err);
        });
    }
  }, [currentCatalog]);
  const [viewMode, setViewMode] = useLocalStorage<'grid' | 'single' | 'list'>('scanner_view_mode', 'grid');
  const [thumbSize, setThumbSize] = useLocalStorage<number>('scanner_thumb_size', 200);
  const [previewZoom, setPreviewZoom] = useState(0); // 0-100%
  const [selectedFolder, setSelectedFolder] = useLocalStorage('scanner_selected_folder', '');
  const [folderPhotos, setFolderPhotos] = useState<ExplorerPhoto[]>([]);
  const [totalFolderPhotos, setTotalFolderPhotos] = useState(0);
  const [isLoadingPhotos, setIsLoadingPhotos] = useState(false);
  
  // Sorting state
  const [sortBy, setSortBy] = useLocalStorage<'name' | 'date' | 'size'>('scanner_sort_by', 'name');
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [completeStats, setCompleteStats] = useState({ photos: 0, faces: 0, time: '' });
  
  // Dragging state
  const [isDragging, setIsDragging] = useState(false);
  const [dragPos, setDragPos] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  
  // UI Options
  const rawEnabled = true;
  const recursiveEnabled = true;

  const [eventFolders, setEventFolders] = useState<string[]>([]);
  const [eventPhotosCount, setEventPhotosCount] = useState(0);
  const [eventPhotosCountStatus, setEventPhotosCountStatus] = useState<'none' | 'loading' | 'done' | 'error'>('none');

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metricsPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // true quando o usuário clicou manualmente em uma foto durante o scan — pausa o auto-follow
  const userNavigatedRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const hasAutoScannedRef = useRef<Record<string, boolean>>({});
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const filmstripRef = useRef<HTMLDivElement | null>(null);
  const [systemMetrics, setSystemMetrics] = useState<{ cpuPercent: number | null; ramUsedGb: number | null; ramPercent: number | null; gpuPercent: number | null; temperatureC: number | null; cpuTemperatureC: number | null } | null>(null);
  const [processedPhotos, setProcessedPhotos] = useState<string[]>([]);
  const [activePhotoIndex, setActivePhotoIndex] = useState(0);
  const [floatingViewerOpen, setFloatingViewerOpen] = useState(false);

  // Selected photo details for bottom panels (Faces)
  const [selectedPhotoFaces, setSelectedPhotoFaces] = useState<{
    status: 'waiting' | 'processing' | 'done';
    faces: SelectedPhotoFaceItem[];
  }>({ status: 'waiting', faces: [] });

  // ── Consumir pendingScanConfig vindo do CatalogModal (scan já iniciado) ──
  useEffect(() => {
    if (!pendingScanConfig) return;
    setEventPath(pendingScanConfig.eventPath);
    setRefPath(pendingScanConfig.refPath);
    setCatalogName(pendingScanConfig.catalogName);
    // Limpa o config para não ser reaproveitado numa próxima montagem
    setPendingScanConfig(null);
    // Inicia o polling de status para refletir o scan que já foi disparado
    void pollScanStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Filter state
  const [showFilters, setShowFilters] = useState(false);
  const [filterSearch, setFilterSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'jpg' | 'raw'>('all');
  const [logFilter, setLogFilter] = useState<'all' | 'error' | 'warning'>('all');

  // Filtered Photos logic
  const filteredFolderPhotos = useMemo(() => {
    return folderPhotos.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(filterSearch.toLowerCase());
      const matchesType = filterType === 'all' || 
                         (filterType === 'raw' && p.is_raw) || 
                         (filterType === 'jpg' && !p.is_raw);
      return matchesSearch && matchesType;
    });
  }, [folderPhotos, filterSearch, filterType]);

  const filteredProcessedPhotos = useMemo(() => {
    return processedPhotos.filter(path => {
      const name = path.split(/[\\/]/).pop() || '';
      const matchesSearch = name.toLowerCase().includes(filterSearch.toLowerCase());
      const ext = name.split('.').pop()?.toLowerCase() || '';
      const isRaw = ['arw', 'cr2', 'nef', 'dng', 'raf', 'orf'].includes(ext);
      const matchesType = filterType === 'all' || 
                         (filterType === 'raw' && isRaw) || 
                         (filterType === 'jpg' && !isRaw);
      return matchesSearch && matchesType;
    });
  }, [processedPhotos, filterSearch, filterType]);

  // Refs para estabilizar os callbacks e evitar re-renders do grid inteiro
  const activePhotosRef = useRef<string[]>([]);
  
  const activePhotos = scanStatus?.is_scanning ? processedPhotos : folderPhotos.map(p => p.path);
  const selectedPhotoPath = activePhotos[activePhotoIndex] ?? '';
  
  // Atualiza a ref sem causar re-render (seguro fazer durante render)
  activePhotosRef.current = activePhotos;

  const handleCardClick = useCallback((path: string) => {
    const realIdx = activePhotosRef.current.indexOf(path);
    if (realIdx >= 0) {
      userNavigatedRef.current = true;
      setActivePhotoIndex(realIdx);
    }
  }, []);

  const handleCardDoubleClick = useCallback((path: string) => {
    const realIdx = activePhotosRef.current.indexOf(path);
    if (realIdx >= 0) {
      setActivePhotoIndex(realIdx);
      setViewMode('single');
      setPreviewZoom(0);
      setDragPos({ x: 0, y: 0 });
    }
  }, []);

  const handleWheelZoom = useCallback((e: React.WheelEvent) => {
    if (viewMode !== 'single') return;
    const delta = e.deltaY * -0.1;
    setPreviewZoom(prev => Math.min(Math.max(prev + delta, 0), 300));
  }, [viewMode]);

  const [previewLoaded, setPreviewLoaded] = useState(false);

  // Keyboard Navigation para Single View
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (viewMode !== 'single') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'Escape') {
        setViewMode('grid');
        setPreviewZoom(0);
        setDragPos({ x: 0, y: 0 });
      } else if (e.key === 'ArrowLeft') {
        navigatePreview(-1);
      } else if (e.key === 'ArrowRight') {
        navigatePreview(1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [viewMode, activePhotoIndex, activePhotos.length]);

  useEffect(() => {
    const el = filmstripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewMode]);

  // Sync bottom panels (Faces) with the selected photo
  // Guard ref para evitar loops: só atualiza se o path realmente mudou
  const lastSelectedPathRef = useRef('');

  useEffect(() => {
    if (!selectedPhotoPath) {
      if (lastSelectedPathRef.current !== '') {
        lastSelectedPathRef.current = '';
        setSelectedPhotoFaces(prev => {
          if (prev.status === 'waiting' && prev.faces.length === 0) return prev;
          return { status: 'waiting', faces: [] };
        });
      }
      return;
    }

    // Se for o mesmo path que já processamos, não faz nada
    if (lastSelectedPathRef.current === selectedPhotoPath) return;
    lastSelectedPathRef.current = selectedPhotoPath;

    const controller = new AbortController();

    // ── HELPER: Buscar faces (preview em tempo real) ──
    const fetchFaces = () => {
      api.previewFaces(selectedPhotoPath).then(result => {
        if (controller.signal.aborted) return;
        if (!result.ok || !result.faces?.length) {
          setSelectedPhotoFaces(prev =>
            prev.status === 'processing' ? { status: 'waiting', faces: [] } : prev
          );
          return;
        }
        setSelectedPhotoFaces({
          status: 'done',
          faces: result.faces.map((f, i) => ({
            id: `face-${i}-${Date.now()}`,
            thumbnail: api.faceThumbUrl(selectedPhotoPath, f.bbox[0], f.bbox[1], f.bbox[2], f.bbox[3], 80),
            suggestedName: 'Desconhecido',
            confidence: f.confidence * 100,
            badge: 'sem_match' as const,
          })),
        });
      }).catch(() => {
        if (!controller.signal.aborted) {
          setSelectedPhotoFaces(prev =>
            prev.status === 'processing' ? { status: 'waiting', faces: [] } : prev
          );
        }
      });
    };

    setSelectedPhotoFaces({ status: 'processing', faces: [] });

    // ── FACES ──
    fetchFaces();

    return () => {
      controller.abort();
    };
  }, [selectedPhotoPath]);



  const handlePickRef = useCallback(async () => {
    const res = await api.selectFolder().catch(() => null);
    if (res?.path) {
      setRefPath(res.path);
      try {
        const [photos, tree] = await Promise.all([
          api.explorePhotos(res.path, { recursive: true, limit: 0, include_raw: true }),
          api.exploreTree(res.path, 1),
        ]);
        const subfolderCount = tree && tree.ok && Array.isArray(tree.children)
          ? tree.children.filter((c: any) => c.type === 'folder').length
          : 0;
        setRefPathInfo({
          photos: photos.total || 0,
          subfolders: subfolderCount,
        });
      } catch {
        setError('Erro ao carregar estatísticas da pasta de referência.');
      }
    }
  }, []);

  const handleAddEventFolder = useCallback(async () => {
    const res = await api.selectFolder().catch(() => null);
    if (res?.path) {
      setEventPath(res.path);
      if (!eventFolders.includes(res.path)) {
        setEventFolders(prev => [...prev, res.path]);
      }
      
      // Tentar autodetectar pasta de referência
      try {
        const tree = await api.exploreTree(res.path, 1).catch(() => null);
        const children = tree?.children ?? [];
        
        const REF_CANDIDATE_NAMES = ['Referências', 'Referencia', 'Referencias', 'Referência', 'Fotos_Referencia', 'Fotos_Referencias', 'FOTOS_REFERENCIA', 'FOTOS_REFERENCIAS', 'referencia', 'referencias'];
        const foundChild = children.find((c: { name: string; path: string }) => 
          REF_CANDIDATE_NAMES.some(cand => cand.toLowerCase() === c.name.toLowerCase())
        );
        
        if (foundChild) {
          setRefPath(foundChild.path);
          // Obter dados de fotos da pasta encontrada e varrer subpastas de forma correta
          const [photos, childTree] = await Promise.all([
            api.explorePhotos(foundChild.path, { recursive: true, limit: 0, include_raw: true }).catch(() => null),
            api.exploreTree(foundChild.path, 1).catch(() => null)
          ]);
          const subCount = childTree && childTree.ok && Array.isArray(childTree.children)
            ? childTree.children.filter((c: any) => c.type === 'folder').length
            : 0;
          setRefPathInfo({
            photos: photos?.total || 0,
            subfolders: subCount,
          });
        }
      } catch (err) {
        console.error('[AutodetectRef] Falha:', err);
      }
    }
  }, [eventFolders]);



  // Sincronizar started_at para o temporizador
  useEffect(() => {
    if (scanStatus?.started_at) startedAtRef.current = scanStatus.started_at;
  }, [scanStatus?.started_at]);

  // Temporizador decorrido em tempo real sincronizado com a IA global
  useEffect(() => {
    if (!isScanning || !startedAtRef.current) {
      setElapsedSeconds(0);
      return;
    }
    const tick = () => {
      if (startedAtRef.current) {
        setElapsedSeconds(Math.floor(Date.now() / 1000 - startedAtRef.current));
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isScanning]);

  // Monitorar conclusão do escaneamento para exibir modal de sucesso
  const prevIsScanningRef = useRef(false);
  useEffect(() => {
    if (prevIsScanningRef.current && !isScanning) {
      if (scanStatus && !scanStatus.stopped) {
        setIsCompleted(true);
        const timeStr = scanStatus.scan_summary?.time_str || '';
        setCompleteStats({
          photos: scanStatus.total_processadas || scanStatus.scan_summary?.total_photos || 0,
          faces: scanStatus.total_faces || scanStatus.scan_summary?.total_faces || 0,
          time: timeStr,
        });
        setShowCompleteModal(true);
      } else {
        setIsCompleted(false);
      }
    }
    prevIsScanningRef.current = isScanning;
  }, [isScanning, scanStatus]);

  // Adicionar fotos processadas em tempo real à filmstrip da interface
  useEffect(() => {
    if (scanStatus?.current_photo?.path) {
      const photoPath = scanStatus.current_photo.path;
      setProcessedPhotos(prev =>
        prev.includes(photoPath) ? prev : [photoPath, ...prev].slice(0, 100)
      );
      if (!userNavigatedRef.current) {
        setActivePhotoIndex(0);
      }
    }
  }, [scanStatus?.current_photo?.path]);

  // Metrics polling: independente do scan, roda sempre que o componente está montado
  useEffect(() => {
    let metricsDelay = 2000;
    let metricsFails = 0;
    const MAX_METRICS_FAILS = 3;
    let metricsActive = true;
    const pollMetrics = async () => {
      if (!metricsActive) return;
      try {
        const m = await api.getSystemMetrics() as { cpuPercent: number | null; ramUsedGb: number | null; ramPercent: number | null; gpuPercent: number | null; temperatureC: number | null; cpuTemperatureC: number | null; status?: string; metricsWarning?: string } | null;
        metricsFails = 0;
        metricsDelay = 2000;
        if (m?.status === 'warming_up') {
          setSystemMetrics(m);
        } else if (m?.metricsWarning === 'gpu_unavailable') {
          setSystemMetrics(m);
        } else {
          setSystemMetrics(m);
        }
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

  // Floating viewer keyboard navigation
  useEffect(() => {
    if (!floatingViewerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFloatingViewerOpen(false);
      if (e.key === 'ArrowLeft') navigatePreview(-1);
      if (e.key === 'ArrowRight') navigatePreview(1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [floatingViewerOpen, activePhotoIndex, activePhotos.length]);

  // Carregar fotos da pasta selecionada
  useEffect(() => {
    if (selectedFolder && !isScanning) {
      const loadPhotos = async () => {
        setIsLoadingPhotos(true);
        try {
          const res = await api.explorePhotos(selectedFolder, { 
            limit: 500, // Aumentado para suportar ordenação local melhor
            recursive: recursiveEnabled,
            include_raw: rawEnabled 
          });
          if (res.ok) {
            const sorted = [...res.photos];
            if (sortBy === 'date') {
              sorted.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
            } else if (sortBy === 'size') {
              sorted.sort((a, b) => (b.size || 0) - (a.size || 0));
            } else {
              sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            }
            setFolderPhotos(sorted);
            setTotalFolderPhotos(res.total);
          }
        } catch (err) {
          console.error('Erro ao carregar fotos da pasta:', err);
        } finally {
          setIsLoadingPhotos(false);
        }
      };
      loadPhotos();
    }
  }, [selectedFolder, isScanning, recursiveEnabled, rawEnabled]);

  // Se a pasta de origem principal mudar, resetar seleção
  useEffect(() => {
    setSelectedFolder(eventPath);
  }, [eventPath]);

  // Ao montar: forçar atualização do status global do scanner
  useEffect(() => {
    void pollScanStatus();
  }, [pollScanStatus]);

  useEffect(() => {
    return () => {
      if (metricsPollRef.current) clearTimeout(metricsPollRef.current);
    };
  }, []);
  
  useEffect(() => {
    if (eventFolders.length === 0) {
      setEventPhotosCount(0);
      setEventPhotosCountStatus('none');
      return;
    }
    const fetchInfo = async () => {
      setEventPhotosCountStatus('loading');
      try {
        let total = 0;
        for (const path of eventFolders) {
          const res = await api.explorePhotos(path, { 
            recursive: recursiveEnabled, 
            limit: 0, 
            include_raw: rawEnabled 
          });
          total += res.total || 0;
        }
        setEventPhotosCount(total);
        setEventPhotosCountStatus('done');
      } catch (e) {
        console.error('Erro ao contar fotos de eventos:', e);
        setEventPhotosCountStatus('error');
      }
    };
    fetchInfo();
  }, [eventFolders, recursiveEnabled, rawEnabled]);





  const handleScan = useCallback(async () => {
    if (!eventPath) { setError('Selecione a pasta de eventos.'); return; }
    const name = catalogName.trim();
    if (!name) { setError('Selecione ou crie um catálogo.'); return; }
    
    setError('');
    setStarting(true);
    setIsCompleted(false);
    userNavigatedRef.current = false;

    try {
      await api.scanFolder(eventPath, refPath || '', name, {
        selected_folders: selectedSubfolders
      });
      try {
        await setCatalog(name);
        await refreshCatalogs();
      } catch (catErr) {
        console.error('[handleScan] Erro ao sincronizar catálogo:', catErr);
      }
      handleScanStarted({ catalogName: name, oriPath: eventPath, refPath: refPath || '' });
    } catch (err: any) {
      console.error('[handleScan] erro ao iniciar:', err);
      if (err && err.status === 400 && err.detail && (err.detail.includes('já está em execução') || err.detail.includes('execução') || err.detail.includes('andamento'))) {
        setError('');
        void pollScanStatus();
      } else {
        const errorMsg = err && err.detail ? err.detail : 'Erro ao iniciar o scan.';
        setError(errorMsg);
      }
    } finally {
      setStarting(false);
    }
  }, [eventPath, catalogName, refPath, selectedSubfolders, setCatalog, refreshCatalogs, handleScanStarted, pollScanStatus]);

  const handleStopScan = useCallback(async () => {
    setStarting(false);
    try {
      await handleCancelScan();
    } catch (err) {
      console.error('[handleStopScan] erro ao cancelar scan:', err);
    }
  }, [handleCancelScan]);

  const progressPct = scanStatus ? Math.min(100, Math.max(0, ((scanStatus.total_processadas ?? 0) / (scanStatus.total_files || 1)) * 100)) : 0;
  const formatTime = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const livePhoto = scanStatus?.current_photo;
  const navPreviewUrl = activePhotos[activePhotoIndex] ? api.thumbUrl(activePhotos[activePhotoIndex], 1200) : '';
  const previewUrl = (isScanning && livePhoto?.preview_url) ? livePhoto.preview_url : navPreviewUrl;
  const floatingImgUrl = activePhotos[activePhotoIndex]
    ? (isScanning && livePhoto?.preview_url ? livePhoto.preview_url : api.previewUrl(activePhotos[activePhotoIndex], 1920))
    : '';
  const navFileName = activePhotos[activePhotoIndex]?.split(/[\\/]/).pop() || '';

  const navigatePreview = useCallback((dir: number) => {
    const next = activePhotoIndex + dir;
    if (next >= 0 && next < activePhotosRef.current.length) {
      setPreviewLoaded(false);
      setActivePhotoIndex(next);
      setPreviewZoom(0);
      setDragPos({ x: 0, y: 0 });
    }
  }, [activePhotoIndex]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (previewZoom <= 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - dragPos.x, y: e.clientY - dragPos.y });
  }, [previewZoom, dragPos]);

  const handleDragMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    setDragPos({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }, [isDragging, dragStart]);

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  return (
    <div className={styles.workspace}>
      {!isScanning && showSetup ? (
        <div className={styles.setupContainer}>
          <div className={styles.setupCard}>
            <div className={styles.setupHeader}>
              <div className={styles.setupIconBadge}>
                <ScanLine size={24} />
              </div>
              <h2>Configurar Scanner de Fotos</h2>
              <p>Selecione as pastas do evento para iniciar a detecção facial inteligente.</p>
            </div>

            <div className={styles.setupBody}>
              {/* CARD 1: Pasta de Fotos do Evento (Obrigatório) */}
              <div 
                className={`${styles.setupFolderCard} ${eventPath ? styles.selected : ''}`}
                onClick={handleAddEventFolder}
              >
                <div className={styles.folderCardIcon}>
                  <ImageIcon size={32} />
                </div>
                <div className={styles.folderCardInfo}>
                  <h3>Pasta de Fotos do Evento</h3>
                  <p className={styles.folderPath}>
                    {eventPath || 'Clique para selecionar a pasta com as fotos do evento...'}
                  </p>
                  {eventPath && (
                    <div className={styles.refInfoRow}>
                      <span className={styles.folderSuccessBadge}>✓ Pasta de fotos vinculada</span>
                      {eventPathInfo && (
                        <span className={styles.refStatsDetail}>
                          ({eventPathInfo.photos} fotos{eventPathInfo.subfolders > 0 ? ` em ${eventPathInfo.subfolders} subpastas` : ''})
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* CARD 2: Pasta de Referência (Opcional) */}
              <div 
                className={`${styles.setupFolderCard} ${refPath ? styles.selectedRef : ''}`}
                onClick={handlePickRef}
              >
                <div className={styles.folderCardIcon}>
                  <Users2 size={32} />
                </div>
                <div className={styles.folderCardInfo}>
                  <h3>Pasta de Referências (Opcional)</h3>
                  <p className={styles.folderPath}>
                    {refPath || 'Clique para selecionar a pasta com fotos nomeadas dos formandos...'}
                  </p>
                  {refPath && (
                    <div className={styles.refInfoRow}>
                      <span className={styles.folderRefBadge}>✓ Referência vinculada</span>
                      {refPathInfo && (
                        <span className={styles.refStatsDetail}>
                          ({refPathInfo.photos} fotos{refPathInfo.subfolders > 0 ? ` em ${refPathInfo.subfolders} subpastas` : ''})
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Seleção de Subpastas de Eventos com Visual Premium */}
              {loadingSubfolders && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  <span className="spin" style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid var(--accent)', borderTopColor: 'transparent', borderRadius: '50%' }} />
                  Carregando subpastas...
                </div>
              )}

              {!loadingSubfolders && eventSubfolders.length > 0 && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
                  <label style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>Confirmar pastas do Evento para incluir no scan:</span>
                  </label>
                  <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>
                    Selecione as subpastas que deseja processar (segure Ctrl para múltiplos cliques).
                  </p>
                  
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    maxHeight: 140,
                    overflowY: 'auto',
                    padding: '8px 10px',
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    borderRadius: 8,
                    marginTop: 4
                  }}>
                    {eventSubfolders.map(sub => {
                      const isSelected = selectedSubfolders.includes(sub.path);
                      return (
                        <label
                          key={sub.path}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 8px',
                            borderRadius: 6,
                            background: isSelected ? 'rgba(236, 72, 153, 0.08)' : 'transparent',
                            border: `1px solid ${isSelected ? 'rgba(236, 72, 153, 0.2)' : 'transparent'}`,
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            userSelect: 'none'
                          }}
                          onClick={(e) => {
                            e.preventDefault();
                            setSelectedSubfolders(prev => {
                              if (prev.includes(sub.path)) {
                                return prev.filter(p => p !== sub.path);
                              } else {
                                return [...prev, sub.path];
                              }
                            });
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            readOnly
                            style={{
                              accentColor: 'var(--accent)',
                              cursor: 'pointer',
                              width: 14,
                              height: 14,
                              margin: 0
                            }}
                          />
                          <Folder size={13} style={{ color: isSelected ? 'var(--accent)' : 'var(--text-muted)' }} />
                          <span style={{ fontSize: '0.78rem', fontWeight: isSelected ? 500 : 400, color: isSelected ? 'var(--text)' : 'var(--text-muted)' }}>
                            {sub.name}
                          </span>
                          <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                            {sub.totalFiles} fotos
                          </span>
                        </label>
                      );
                    })}
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                    <button
                      type="button"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--accent)',
                        fontSize: '0.72rem',
                        cursor: 'pointer',
                        padding: 0,
                        fontWeight: 500
                      }}
                      onClick={() => setSelectedSubfolders(eventSubfolders.map(s => s.path))}
                    >
                      Selecionar Todas
                    </button>
                    <span style={{ color: 'rgba(255, 255, 255, 0.15)', fontSize: '0.72rem' }}>|</span>
                    <button
                      type="button"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-muted)',
                        fontSize: '0.72rem',
                        cursor: 'pointer',
                        padding: 0
                      }}
                      onClick={() => setSelectedSubfolders([])}
                    >
                      Desmarcar Todas
                    </button>
                  </div>
                </div>
              )}

              {/* Campo inferior: Nome do Evento/Catálogo */}
              <div className={styles.setupInputRow}>
                <div className={styles.setupInputField}>
                  <label>Evento / Catálogo</label>
                  <input
                    type="text"
                    placeholder="Nome do evento (ex.: Medicina Unipac 2025)..."
                    value={catalogName}
                    onChange={e => setCatalogName(e.target.value)}
                  />
                </div>
                <button 
                  className={styles.setupSubmitBtn} 
                  onClick={handleScan}
                  disabled={!eventPath || starting}
                >
                  {starting ? (
                    <LoaderCircle size={16} className={styles.spin} />
                  ) : (
                    <Zap size={16} fill="currentColor" />
                  )}
                  <span>Iniciar Scanner</span>
                </button>
              </div>

              {error && (
                <div className={styles.setupError}>
                  <AlertTriangle size={14} />
                  <span>{error}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* ── TOP SUMMARY BAR ── */}
          <div className={styles.summaryBar}>
            <div className={styles.summaryHeader}>
              <h1>Scanner PRO</h1>
              <p>Ingestão inteligente com IA</p>
            </div>

            <div className={styles.summaryStats}>
              <div className={styles.summaryStat}>
                <span className={styles.statLabel}>Encontradas</span>
                <span className={`${styles.statValue} ${isScanning ? styles.processing : isCompleted ? styles.completed : ''}`}>
                  {new Intl.NumberFormat('pt-BR').format(scanStatus?.total_files || 0)} 
                  <span className={styles.statSub}>fotos</span>
                </span>
              </div>
              <div className={styles.summaryStat}>
                <span className={styles.statLabel}>Processadas</span>
                <span className={`${styles.statValue} ${isScanning ? styles.processing : isCompleted ? styles.completed : ''}`}>
                  {new Intl.NumberFormat('pt-BR').format(scanStatus?.total_processadas || 0)} 
                  <span className={styles.statSub}>{Math.round(progressPct)}%</span>
                </span>
              </div>
              <div className={styles.summaryStat}>
                <span className={styles.statLabel}>Pendentes</span>
                <span className={styles.statValue}>
                  {new Intl.NumberFormat('pt-BR').format((scanStatus?.total_files || 0) - (scanStatus?.total_processadas || 0))} 
                  <span className={styles.statSub}>{Math.round(100 - progressPct)}%</span>
                </span>
              </div>
              <div className={styles.summaryStat}>
                <span className={styles.statLabel}>Duplicadas</span>
                <span className={`${styles.statValue} ${styles.warning}`}>
                  {scanStatus?.duplicate_count ?? '--'} 
                  <span className={styles.statSub}>
                    {scanStatus?.duplicate_percent ? `/ ${scanStatus.duplicate_percent}%` : ''}
                  </span>
                </span>
              </div>
              {isScanning && (
                <div className={styles.summaryStat}>
                  <span className={styles.statLabel}>Tempo decorrido</span>
                  <span className={styles.statValue}>{formatTime(elapsedSeconds)}</span>
                </div>
              )}
              {isScanning && (() => {
                const processed = scanStatus?.total_processadas || 0;
                const total = scanStatus?.total_files || 0;
                const etaRaw = scanStatus?.eta_seconds;
                let etaSec: number | null = null;
                if (etaRaw != null && etaRaw > 0) {
                  etaSec = etaRaw;
                } else if (processed >= 5 && processed < total && scanStatus?.started_at) {
                  const elapsed = Date.now() / 1000 - scanStatus.started_at;
                  const speed = processed / elapsed;
                  const remaining = total - processed;
                  if (remaining > 0 && speed > 0) etaSec = remaining / speed;
                }
                return (
                  <div className={styles.summaryStat}>
                    <span className={styles.statLabel}>Tempo restante</span>
                    <span className={styles.statValue}>
                      {processed < 5
                        ? 'Calculando...'
                        : processed >= total
                          ? 'Finalizando...'
                          : etaSec != null && etaSec > 0
                            ? formatTime(Math.ceil(etaSec))
                            : 'Calculando...'}
                      {etaSec != null && etaSec > 0 && processed < total && (
                        <span className={styles.statSub}>restante</span>
                      )}
                    </span>
                  </div>
                );
              })()}
              {!isScanning && (
                <div className={styles.summaryStat}>
                  <span className={styles.statLabel}>Duração</span>
                  <span className={styles.statValue}>{scanStatus?.scan_summary?.time_str || '--'}</span>
                </div>
              )}
            </div>

            <div className={styles.summaryActions}>
              {!isScanning && (processedPhotos.length > 0 || isCompleted) && (
                <button className={styles.newScanBtn} onClick={() => setShowSetup(true)}>
                  <ScanLine size={12} /> Novo Escaneamento
                </button>
              )}
              {isScanning && (
                <button className={styles.pauseBtn} onClick={() => setIsFeedPaused(!isFeedPaused)}>
                  {isFeedPaused ? <Play size={12} /> : <Pause size={12} />}
                  {isFeedPaused ? 'Retomar' : 'Pausar'}
                </button>
              )}
              <button className={styles.stopBtn} onClick={handleStopScan} disabled={!isScanning}>
                <X size={12} /> Parar
              </button>
            </div>
          </div>

          <div className={styles.mainLayout}>
            {/* ── CENTER PANEL: PREVIEW / GRID ── */}
            <div className={styles.centerPanel}>
              <div className={styles.previewHeader}>
                <div className={styles.headerLeft}>
                  <div className={styles.viewToggles}>
                    <button 
                      className={`${styles.toggleBtn} ${viewMode === 'grid' ? styles.active : ''}`} 
                      onClick={() => setViewMode('grid')}
                      title="Grade"
                    >
                      <LayoutGrid size={14} />
                    </button>
                    <button 
                      className={`${styles.toggleBtn} ${viewMode === 'single' ? styles.active : ''}`} 
                      onClick={() => setViewMode('single')}
                      title="Individual"
                    >
                      <ImageIcon size={14} />
                    </button>
                    <button 
                      className={`${styles.toggleBtn} ${viewMode === 'list' ? styles.active : ''}`} 
                      onClick={() => setViewMode('list')}
                      title="Lista"
                    >
                      <List size={14} />
                    </button>
                  </div>
                  <div className={styles.zoomControl}>
                    <input 
                      type="range" 
                      className={styles.slider} 
                      min={viewMode === 'single' ? "0" : "80"} 
                      max={viewMode === 'single' ? "300" : "300"} 
                      value={viewMode === 'single' ? previewZoom : thumbSize} 
                      onChange={e => {
                        const val = parseInt(e.target.value);
                        if (viewMode === 'single') setPreviewZoom(val);
                        else setThumbSize(val);
                      }} 
                      style={{ width: 80 }} 
                    />
                    <span className={styles.zoomValue}>{viewMode === 'single' ? `${Math.round(previewZoom)}%` : `${thumbSize}px`}</span>
                    {viewMode === 'single' && (
                      <button className={styles.toggleBtn} onClick={() => setFloatingViewerOpen(true)} title="Tela cheia" style={{ marginLeft: 8 }}>
                        <Maximize2 size={12} />
                      </button>
                    )}
                  </div>
                  
                  {selectedFolder && (
                    <div className={styles.previewFileName}>
                      <Folder size={12} style={{marginRight: 6, verticalAlign: 'middle', color: '#60a5fa'}} />
                      {selectedFolder.split(/[\\/]/).pop()}
                    </div>
                  )}

                  {viewMode === 'single' && activePhotos.length > 0 && (
                    <div className={styles.singleViewMeta}>
                      <span className={styles.singleViewIndex}>{activePhotoIndex + 1} / {activePhotos.length}</span>
                      <span className={styles.previewFileName}>{navFileName}</span>
                    </div>
                  )}

                  <div style={{ position: 'relative' }}>
                    <button 
                      className={`${styles.destBtn} ${showFilters ? styles.activeFilters : ''}`} 
                      style={{ height: 24 }}
                      onClick={() => setShowFilters(!showFilters)}
                    >
                      <SlidersHorizontal size={12} /> Filtros
                      {(filterSearch || filterType !== 'all') && <div className={styles.filterDot} />}
                    </button>

                    {showFilters && (
                      <div className={styles.filterPanel}>
                        <div className={styles.filterPanelHeader}>
                          <span className={styles.filterPanelTitle}>Filtros de Visualização</span>
                          <button className={styles.filterPanelClose} onClick={() => setShowFilters(false)}><X size={12} /></button>
                        </div>
                        <div className={styles.filterPanelBody}>
                          <div className={styles.filterGroup}>
                            <label className={styles.filterLabel}>Buscar por nome</label>
                            <div className={styles.filterSearchWrap}>
                              <Search size={12} className={styles.filterSearchIcon} />
                              <input 
                                className={styles.filterSearchInput} 
                                placeholder="Ex: DSC_001..." 
                                value={filterSearch}
                                onChange={e => setFilterSearch(e.target.value)}
                                autoFocus
                              />
                              {filterSearch && (
                                <button className={styles.filterSearchClear} onClick={() => setFilterSearch('')}>
                                  <X size={10} />
                                </button>
                              )}
                            </div>
                          </div>
                          
                          <div className={styles.filterGroup}>
                            <label className={styles.filterLabel}>Tipo de Arquivo</label>
                            <div className={styles.filterToggles}>
                              <button 
                                className={`${styles.filterToggleBtn} ${filterType === 'all' ? styles.filterToggleActive : ''}`}
                                onClick={() => setFilterType('all')}
                              >
                                Todos
                              </button>
                              <button 
                                className={`${styles.filterToggleBtn} ${filterType === 'jpg' ? styles.filterToggleActive : ''}`}
                                onClick={() => setFilterType('jpg')}
                              >
                                JPEG
                              </button>
                              <button 
                                className={`${styles.filterToggleBtn} ${filterType === 'raw' ? styles.filterToggleActive : ''}`}
                                onClick={() => setFilterType('raw')}
                              >
                                RAW
                              </button>
                            </div>
                          </div>
                          <div className={styles.filterGroup}>
                            <label className={styles.filterLabel}>Ordenação</label>
                            <select 
                              className={styles.inputBase}
                              value={sortBy}
                              onChange={e => setSortBy(e.target.value as 'name' | 'date' | 'size')}
                            >
                              <option value="name">Nome (Alfabética/Numérica)</option>
                              <option value="date">Data de Modificação</option>
                              <option value="size">Tamanho do Arquivo</option>
                            </select>
                          </div>
                        </div>
                        <div className={styles.filterPanelFooter}>
                          <button className={styles.filterResetBtn} onClick={() => {
                            setFilterSearch('');
                            setFilterType('all');
                          }}>
                            Limpar Filtros
                          </button>
                          <span className={styles.filterResultCount}>
                            {isScanning ? filteredProcessedPhotos.length : filteredFolderPhotos.length} fotos
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className={styles.headerRight}>
                  <span className={styles.photoCount}>
                    {isScanning ? (
                      `${new Intl.NumberFormat('pt-BR').format(scanStatus?.total_processadas || 0)} / ${new Intl.NumberFormat('pt-BR').format(scanStatus?.total_files || 0)}`
                    ) : (
                      new Intl.NumberFormat('pt-BR').format(totalFolderPhotos)
                    )} fotos
                  </span>
                </div>
              </div>

              {viewMode === 'single' && activePhotos.length > 0 ? (
                <div className={styles.singleViewContainer}>
                  <div className={styles.previewMain}>
                    <button className={`${styles.previewNavBtn} ${styles.previewNavPrev}`} onClick={() => navigatePreview(-1)}>
                      <ChevronLeft size={32} />
                    </button>
                    <button className={`${styles.previewNavBtn} ${styles.previewNavNext}`} onClick={() => navigatePreview(1)}>
                      <ChevronRightIcon size={32} />
                    </button>
                    
                    <div 
                      className={styles.previewImageWrap}
                      onMouseDown={handleDragStart}
                      onMouseMove={handleDragMove}
                      onMouseUp={handleDragEnd}
                      onMouseLeave={handleDragEnd}
                      onWheel={handleWheelZoom}
                      style={{ cursor: previewZoom > 0 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
                    >
                        <div
                          className={styles.previewImageInner}
                          style={{ 
                            transform: `scale(${1 + (previewZoom / 100) * 2}) translate(${dragPos.x / (1 + (previewZoom/100)*2)}px, ${dragPos.y / (1 + (previewZoom/100)*2)}px)`,
                            transition: isDragging ? 'none' : 'transform 0.2s ease-out'
                          }}
                        >
                          <img 
                            key={activePhotos[activePhotoIndex]}
                            src={previewUrl}
                            className={`${styles.previewImage} ${previewLoaded ? styles.previewImageLoaded : styles.previewImageLoading}`} 
                            alt={navFileName}
                            onLoad={() => setPreviewLoaded(true)}
                            draggable={false}
                            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
                          />
                        </div>
                    </div>
                  </div>

                  <div className={styles.keyHintBar}>
                    <span><kbd className={styles.kbd}>←</kbd><kbd className={styles.kbd}>→</kbd> navegar</span>
                    <span><kbd className={styles.kbd}>scroll</kbd> zoom</span>
                    <span><kbd className={styles.kbd}>Esc</kbd> voltar à grade</span>
                  </div>

                  <div
                    className={styles.singleFilmstrip}
                    ref={filmstripRef}
                  >
                    {activePhotos.map((p, i) => {
                      if (Math.abs(i - activePhotoIndex) > 30) return null;
                      return (
                        <div 
                          key={p} 
                          className={`${styles.singleFilmstripCard} ${i === activePhotoIndex ? styles.singleFilmstripCardActive : ''}`}
                          onClick={() => {
                            userNavigatedRef.current = true;
                            setPreviewLoaded(false);
                            setActivePhotoIndex(i);
                            setPreviewZoom(0);
                            setDragPos({ x: 0, y: 0 });
                          }}
                          ref={el => {
                            if (el && i === activePhotoIndex) {
                               el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
                            }
                          }}
                        >
                          <img src={api.thumbUrl(p, 120)} loading="lazy" alt="thumb" />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : viewMode === 'list' ? (
                <div className={styles.listContent}>
                  <table className={styles.listTable}>
                    <thead>
                      <tr>
                        <th>Arquivo</th>
                        <th>Tipo</th>
                        <th>Status</th>
                        <th>Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(scanStatus?.is_scanning ? processedPhotos : folderPhotos.map(p => p.path)).map((path, i) => (
                        <tr key={i}>
                          <td>
                            <div className={styles.listFileName}>
                              <ImageIcon size={12} />
                              {path.split(/[\\/]/).pop()}
                            </div>
                          </td>
                          <td><span className={styles.extBadge}>{path.split('.').pop()?.toUpperCase()}</span></td>
                          <td>
                            <div className={styles.listStatus}>
                              <CheckCircle2 size={10} color="#10b981" />
                              <span>Processado</span>
                            </div>
                          </td>
                          <td>
                            <button 
                              className={styles.destBtn} 
                              onClick={() => {
                                setActivePhotoIndex(i);
                                viewMode === 'single';
                              }}
                            >
                              <Maximize2 size={10} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div 
                  className={styles.gridContent} 
                  style={{ '--thumb-size': `${thumbSize}px` } as React.CSSProperties}
                >
                  {isLoadingPhotos && (
                    <div className={styles.previewEmpty}>
                      <LoaderCircle size={24} className="spin" />
                      <p className={styles.previewEmptyText}>Carregando miniaturas...</p>
                    </div>
                  )}

                  {!isLoadingPhotos && isScanning && filteredProcessedPhotos.map((path, i) => (
                    <ScannerPhotoCard 
                      key={`${path}-${i}`} 
                      path={path} 
                      isActive={activePhotos.indexOf(path) === activePhotoIndex}
                      onClick={handleCardClick}
                      onDoubleClick={handleCardDoubleClick}
                    />
                  ))}

                  {!isLoadingPhotos && !isScanning && filteredFolderPhotos.map((photo, i) => (
                    <ScannerPhotoCard 
                      key={`${photo.path}-${i}`} 
                      path={photo.path} 
                      ext={photo.ext} 
                      isActive={activePhotos.indexOf(photo.path) === activePhotoIndex}
                      onClick={handleCardClick}
                      onDoubleClick={handleCardDoubleClick}
                    />
                  ))}

                  {!isLoadingPhotos && !isScanning && folderPhotos.length > 0 && filteredFolderPhotos.length === 0 && (
                    <div className={styles.previewEmpty}>
                      <Search size={48} style={{ opacity: 0.1 }} />
                      <p className={styles.previewEmptyText}>Nenhuma foto corresponde aos filtros aplicados</p>
                      <button className={styles.alterBtn} style={{ marginTop: 12 }} onClick={() => {
                        setFilterSearch('');
                        setFilterType('all');
                      }}>
                        Limpar Filtros
                      </button>
                    </div>
                  )}

                  {!isLoadingPhotos && !isScanning && folderPhotos.length === 0 && !processedPhotos.length && (
                    <div className={styles.previewEmpty}>
                      <ImageIcon size={48} />
                      <p className={styles.previewEmptyText}>Selecione uma pasta para visualizar as fotos</p>
                    </div>
                  )}
                </div>
              )}

              <div className={styles.bottomPanels}>
                <div className={styles.detailSection}>
                  <div className={styles.detailHeader}>
                    <span className={styles.detailTitle}><ScanFace size={11} /> Rostos detectados</span>
                    <span className={styles.detailCount}>
                      {isScanning
                        ? `${(scanStatus?.recent_faces || []).length} rostos`
                        : selectedPhotoFaces.status === 'waiting' ? '-' : `${selectedPhotoFaces.faces.length} rostos`}
                    </span>
                  </div>
                  {isScanning ? (
                    scanStatus?.recent_faces && scanStatus.recent_faces.length > 0 ? (
                      <div className={styles.filmstrip}>
                        {scanStatus.recent_faces.slice(0, 50).map((face) => (
                          <div key={face.id} className={styles.faceCard}>
                            <div className={styles.faceImageWrap}>
                              <img
                                src={api.faceThumbUrl(face.path, face.box[0], face.box[1], face.box[2], face.box[3], 80)}
                                className={styles.faceImage}
                                alt={face.name}
                              />
                            </div>
                            <div className={styles.faceMeta}>
                              <span className={styles.faceName}>{face.name}</span>
                              <span className={styles.faceConfidence}>{(face.confidence * 100).toFixed(0)}%</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className={styles.ocrEmpty}>
                        {activePhotos.length > 0
                          ? 'Aguardando detecção facial...'
                          : 'Nenhum rosto detectado ainda.'}
                      </div>
                    )
                  ) : selectedPhotoFaces.status === 'waiting' || selectedPhotoFaces.faces.length === 0 ? (
                    <div className={styles.ocrEmpty}>
                      {activePhotos.length > 0
                        ? 'Aguardando detecção facial...'
                        : 'Selecione uma foto para ver rostos detectados'}
                    </div>
                  ) : (
                    <div className={styles.filmstrip}>
                      {selectedPhotoFaces.faces.map((face) => (
                        <div key={face.id} className={styles.faceCard}>
                          <div className={styles.faceImageWrap}>
                            <img src={face.thumbnail} className={styles.faceImage} alt="Face" />
                          </div>
                          <div className={styles.faceMeta}>
                            <span className={styles.faceName}>{face.suggestedName}</span>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                              <span className={styles.faceConfidence}>{face.confidence.toFixed(1)}%</span>
                              <span className={
                                face.badge === 'ia' ? `${styles.badge} ${styles.badgeAmber}` :
                                face.badge === 'similar' ? `${styles.badge} ${styles.badgeGreen}` :
                                `${styles.badge} ${styles.badgePurple}`
                              } style={{ fontSize: 6, padding: '1px 4px', borderRadius: 3 }}>
                                {face.badge === 'ia' ? 'IA' : face.badge === 'similar' ? 'Similar' : 'Sem match'}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── RIGHT PANEL: PROCESS ── */}
            <div className={styles.rightPanel}>
              <div className={styles.processCard}>
                <div className={styles.processHeader}>
                  <span className={styles.processTitle}><Gauge size={11} /> Processamento</span>
                  {isScanning && <span className={`${styles.badge} ${styles.badgeAmber}`}>Ativo</span>}
                </div>
                <div className={styles.gaugeWrap}>
                  <CircularGauge pct={progressPct} />
                </div>
                <div className={styles.progressInfo}>
                  <span className={styles.progressCount}>
                    {new Intl.NumberFormat('pt-BR').format(scanStatus?.total_processadas || 0)} / {new Intl.NumberFormat('pt-BR').format(scanStatus?.total_files || 0)}
                  </span>
                  <span className={styles.progressSpeed}>285 fotos/min</span>
                </div>
                <div className={styles.stageRow}>
                  <span className={styles.label}>Etapa atual:</span>
                  <span className={styles.stageValue}>{scanStatus?.status_text || 'Inativo'}</span>
                </div>
                <div className={styles.progressBar}>
                  <div className={styles.progressBarFill} style={{ width: `${progressPct}%` }} />
                </div>
              </div>

              <div className={styles.processCard}>
                <span className={styles.processTitle} style={{ marginBottom: 10 }}>Fila de trabalho</span>
                <div className={styles.queueList}>
                  <div className={styles.queueItem}>
                    <div className={styles.queueLabel}><div className={styles.dot} style={{ background: '#10b981' }} /> Análise IA</div>
                    <div className={styles.queueValue}><span>{new Intl.NumberFormat('pt-BR').format(scanStatus?.total_processadas || 0)}</span> <CheckCircle2 size={10} color="#10b981" /></div>
                  </div>
                  <div className={styles.queueItem}>
                    <div className={styles.queueLabel}><div className={styles.dot} style={{ background: '#3b82f6' }} /> Rostos</div>
                    <div className={styles.queueValue}><span>{new Intl.NumberFormat('pt-BR').format(scanStatus?.total_matches || 0)}</span></div>
                  </div>
                  <div className={styles.queueItem}>
                    <div className={styles.queueLabel}><div className={styles.dot} style={{ background: '#475569' }} /> Finalização</div>
                    <div className={styles.queueValue}><span>0</span></div>
                  </div>
                </div>
              </div>

              <div className={styles.logSection}>
                <div className={styles.logHeader}>
                  <span className={styles.processTitle}><Terminal size={11} /> Logs</span>
                  <div className={styles.logFilterRow}>
                    {(['all', 'error', 'warning'] as const).map(f => (
                      <button
                        key={f}
                        className={`${styles.logFilterBtn} ${logFilter === f ? styles.logFilterBtnActive : ''}`}
                        onClick={() => setLogFilter(f)}
                      >
                        {f === 'all' ? 'Todos' : f === 'error' ? 'Erros' : 'Avisos'}
                      </button>
                    ))}
                    <button className={styles.alterBtn} style={{ height: 20, fontSize: 8 }} onClick={resetProcessingPanel}>Limpar</button>
                  </div>
                </div>
                <div className={styles.logBox}>
                  {timeline.length > 0 ? timeline.slice().reverse()
                    .filter(e => logFilter === 'all' || e.kind === logFilter)
                    .map(entry => (
                      <div
                        key={entry.id}
                        className={`${styles.logEntry} ${entry.kind === 'error' ? styles.logEntryError : entry.kind === 'warning' ? styles.logEntryWarning : ''}`}
                      >
                        <span className={styles.logTime}>{new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })}</span>
                        <span className={styles.logText}>{entry.text}</span>
                      </div>
                  )) : (
                    <div className={styles.logEmpty}>Nenhum log no momento</div>
                  )}
                </div>
              </div>

              <div className={styles.systemMetrics}>
                <div className={styles.metricItem} style={{ gridColumn: '1 / -1' }}>
                  <ScanFace size={12} className={styles.metricIcon} />
                  <span className={styles.metricLabel}>AI</span>
                  <span className={styles.metricValue} style={{ color: scanStatus?.device === 'GPU' ? '#10b981' : '#f59e0b' }}>
                    {scanStatus?.provider ? (scanStatus.device_label || (scanStatus.device === 'GPU' ? 'GPU' : 'CPU')) : '--'}
                  </span>
                </div>
                <div className={styles.metricItem}>
                  <Monitor size={12} className={styles.metricIcon} />
                  <span className={styles.metricLabel}>GPU</span>
                  <span className={styles.metricValue}>{systemMetrics?.gpuPercent != null ? `${systemMetrics.gpuPercent}%` : '--'}</span>
                </div>
                <div className={styles.metricItem}>
                  <Cpu size={12} className={styles.metricIcon} />
                  <span className={styles.metricLabel}>CPU</span>
                  <span className={styles.metricValue}>{systemMetrics?.cpuPercent != null ? `${systemMetrics.cpuPercent}%` : '--'}</span>
                </div>
                <div className={styles.metricItem}>
                  <HardDrive size={12} className={styles.metricIcon} />
                  <span className={styles.metricLabel}>RAM</span>
                  <span className={styles.metricValue}>{systemMetrics?.ramUsedGb != null ? `${systemMetrics.ramUsedGb.toFixed(1)}GB` : '--'}</span>
                </div>
                <div className={styles.metricItem}>
                  <HardDrive size={12} className={styles.metricIcon} />
                  <span className={styles.metricLabel}>RAM%</span>
                  <span className={styles.metricValue}>{systemMetrics?.ramPercent != null ? `${systemMetrics.ramPercent}%` : '--'}</span>
                </div>
                <div className={styles.metricItem}>
                  <Zap size={12} className={styles.metricIcon} />
                  <span className={styles.metricLabel}>Temp GPU</span>
                  <span className={styles.metricValue}>{systemMetrics?.temperatureC != null ? `${systemMetrics.temperatureC}°C` : '--'}</span>
                </div>
                <div className={styles.metricItem} title={systemMetrics?.cpuTemperatureC == null ? 'Temperatura da CPU indisponível neste sistema' : ''}>
                  <Zap size={12} className={styles.metricIcon} />
                  <span className={styles.metricLabel}>Temp CPU</span>
                  <span className={styles.metricValue}>{systemMetrics?.cpuTemperatureC != null ? `${systemMetrics.cpuTemperatureC}°C` : '--'}</span>
                </div>
              </div>
            </div>
          </div>

          {floatingViewerOpen && activePhotos[activePhotoIndex] && (
            <div className={styles.floatingViewer} onClick={() => setFloatingViewerOpen(false)}>
              <button className={styles.floatingClose} onClick={() => setFloatingViewerOpen(false)} title="Fechar">
                <X size={20} />
              </button>
              <button className={`${styles.floatingNav} ${styles.floatingNavPrev}`} onClick={(e) => { e.stopPropagation(); navigatePreview(-1); }} title="Anterior">
                <ChevronLeft size={28} />
              </button>
              <button className={`${styles.floatingNav} ${styles.floatingNavNext}`} onClick={(e) => { e.stopPropagation(); navigatePreview(1); }} title="Próxima">
                <ChevronRightIcon size={28} />
              </button>
              <img
                className={styles.floatingImage}
                src={floatingImgUrl}
                alt={navFileName}
                onClick={(e) => e.stopPropagation()}
                draggable={false}
              />
            </div>
          )}

          {/* ── BOTTOM STATUS BAR ── */}
          <div className={styles.statusBar}>
            <div className={styles.statusItem}>
              <div className={`${styles.statusDot} ${isScanning ? styles.statusDotProcessing : isCompleted ? styles.statusDotComplete : styles.statusDotIdle}`} />
              Status: <span className={styles.statusValue}>{isScanning ? 'Escaneando' : isCompleted ? 'Concluído' : 'Aguardando'}</span>
            </div>
            <div className={styles.statusItem}>Catálogo: <span className={styles.statusValue}>{currentCatalog || 'Nenhum'}</span></div>
            <div className={styles.statusItem}>Versão Engine: <span className={styles.statusValue}>v2.1.4-hybrid</span></div>
            <div className={styles.statusItem} style={{ marginLeft: 'auto' }}><Activity size={10} /> System Healthy</div>
          </div>

          {/* ── SCAN COMPLETE MODAL ── */}
          <ScanCompleteModal
            show={showCompleteModal}
            totalPhotos={completeStats.photos}
            totalFaces={completeStats.faces}
            totalTime={completeStats.time}
            onClose={() => setShowCompleteModal(false)}
            onGoPeople={() => { setShowCompleteModal(false); navigate('people'); }}
            onGoReview={() => { setShowCompleteModal(false); navigate('review'); }}
          />
        </>
      )}
    </div>
  );
});

export default ScannerWorkspace;
