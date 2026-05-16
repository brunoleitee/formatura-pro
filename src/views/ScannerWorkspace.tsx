import { useState, useEffect, useCallback, useRef, memo, useMemo } from 'react';
import { 
  FolderOpen, Scan, X, Plus, Cpu, ScanFace, Layers3, Sparkles, 
  Maximize2, LayoutGrid, Search, Info, AlertTriangle, Blocks, Wand2, 
  Check, CheckCircle2, Circle, Database, Terminal, Zap, Gauge, Activity, Calendar, 
  Play, Pause, Folder, LoaderCircle, ChevronDown, List, SlidersHorizontal,
  HardDrive, Monitor, MousePointer2, Users, Eye, ChevronRight as ChevronRightIcon, ChevronLeft, FolderSearch,
  Image as ImageIcon
} from 'lucide-react';
import { api, type ScanStatus, type ScanRecentFace, type ExplorerPhoto } from '../services/api';
import FolderTree from '../components/scan/FolderTree';
import { useApp } from '../context/AppContext';
import styles from './ScannerWorkspace.module.css';
import ScannerEventFolderManager from '../components/scan/manager/ScannerEventFolderManager';

interface TimelineEntry {
  id: string;
  kind: 'system' | 'face' | 'match' | 'cluster' | 'summary' | 'warning' | 'error';
  text: string;
  timestamp: number;
}

interface SelectedPhotoOcrData {
  path: string;
  status: 'loading' | 'done' | 'empty' | 'error';
  fileName: string;
  rawText?: string;
  fields?: {
    nome?: string | null;
    curso?: string | null;
    instituicao?: string | null;
    data?: string | null;
    tipo?: string | null;
    numero?: string | null;
  };
  confidence?: number | null;
  error?: string;
}

interface SelectedPhotoFaceItem {
  id: string;
  thumbnail: string;
  suggestedName: string;
  confidence: number;
  badge: 'ocr' | 'ia' | 'similar' | 'sem_match';
}

// Sub-component for Collapsible Sections in Sidebar
const CollapsibleSection = ({ title, icon: Icon, children, defaultOpen = true }: any) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className={styles.configSection}>
      <div className={styles.configHeader} onClick={() => setIsOpen(!isOpen)}>
        <div className={styles.configHeaderLeft}>
          <ChevronRightIcon size={14} className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`} />
          <Icon size={14} className={styles.sectionIcon} />
          <span className={styles.configTitle}>{title}</span>
        </div>
      </div>
      <div className={`${styles.configBody} ${!isOpen ? styles.configBodyCollapsed : ''}`}>
        {children}
      </div>
    </div>
  );
};

const ScannerWorkspace = memo(function ScannerWorkspace() {
  const { catalogs, setCatalog, refreshCatalogs, currentCatalog } = useApp();
  const [oriPath, setOriPath] = useState('');
  const [refPath, setRefPath] = useState('');
  const [refPathInfo, setRefPathInfo] = useState<{ photos: number; subfolders: number } | null>(null);
  const [catalogName, setCatalogName] = useState('');
  const [newCatalogName, setNewCatalogName] = useState('');
  const [newCatalogMode, setNewCatalogMode] = useState(false);
  const [showNewCatalogInput, setShowNewCatalogInput] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const [isFeedPaused, setIsFeedPaused] = useState(false);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'single' | 'list'>(() => (localStorage.getItem('scanner_view_mode') as any) || 'grid');
  const [thumbSize, setThumbSize] = useState(() => Number(localStorage.getItem('scanner_thumb_size')) || 200);
  const [previewZoom, setPreviewZoom] = useState(0); // 0-100%
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState(() => localStorage.getItem('scanner_selected_folder') || '');
  const [folderPhotos, setFolderPhotos] = useState<ExplorerPhoto[]>([]);
  const [totalFolderPhotos, setTotalFolderPhotos] = useState(0);
  const [isLoadingPhotos, setIsLoadingPhotos] = useState(false);
  
  // Sorting state
  const [sortBy, setSortBy] = useState<'name' | 'date' | 'size'>(() => (localStorage.getItem('scanner_sort_by') as any) || 'name');
  
  // Dragging state
  const [isDragging, setIsDragging] = useState(false);
  const [dragPos, setDragPos] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  
  // UI Options
  const [aiModel, setAiModel] = useState('FormaturaPRO - High Quality');
  const [ocrEnabled, setOcrEnabled] = useState(true);
  const [gpuEnabled, setGpuEnabled] = useState(true);
  const [quality, setQuality] = useState(70);
  const [rawEnabled, setRawEnabled] = useState(true);
  const [recursiveEnabled, setRecursiveEnabled] = useState(true);
  const [faceRecEnabled, setFaceRecEnabled] = useState(true);
  const [blurFilter, setBlurFilter] = useState('Médio');

  const [eventFolders, setEventFolders] = useState<string[]>([]);
  const [selectedEventFolders, setSelectedEventFolders] = useState<string[]>([]);
  const [eventFolderStatuses, setEventFolderStatuses] = useState<Record<string, Record<string, 'include' | 'ignore' | 'monitor'>>>({});
  const [eventPhotosCount, setEventPhotosCount] = useState(0);
  const [eventPhotosCountStatus, setEventPhotosCountStatus] = useState<'none' | 'loading' | 'done' | 'error'>('none');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const metricsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const filmstripRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [systemMetrics, setSystemMetrics] = useState<{ gpuLoad: number | null; cpuLoad: number | null; ramUsedGb: number | null; tempC: number | null } | null>(null);
  const [liveFaceBoxes, setLiveFaceBoxes] = useState<{ bbox: number[]; confidence: number }[]>([]);
  const [naturalDims, setNaturalDims] = useState({ w: 0, h: 0 });
  const [processedPhotos, setProcessedPhotos] = useState<string[]>([]);
  const [activePhotoIndex, setActivePhotoIndex] = useState(0);

  // Selected photo details for bottom panels (OCR + Faces)
  const [selectedPhotoOcr, setSelectedPhotoOcr] = useState<SelectedPhotoOcrData | null>(null);
  const [selectedPhotoFaces, setSelectedPhotoFaces] = useState<{
    status: 'waiting' | 'processing' | 'done';
    faces: SelectedPhotoFaceItem[];
  }>({ status: 'waiting', faces: [] });
  const ocrCacheRef = useRef<Record<string, SelectedPhotoOcrData>>({});

  // Filter state
  const [showFilters, setShowFilters] = useState(false);
  const [filterSearch, setFilterSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'jpg' | 'raw'>('all');

  const [showEventManager, setShowEventManager] = useState(false);

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
    if (realIdx >= 0) setActivePhotoIndex(realIdx);
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

  // Persistence Effects
  useEffect(() => {
    localStorage.setItem('scanner_selected_folder', selectedFolder);
  }, [selectedFolder]);

  useEffect(() => {
    localStorage.setItem('scanner_view_mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem('scanner_thumb_size', thumbSize.toString());
  }, [thumbSize]);

  useEffect(() => {
    localStorage.setItem('scanner_sort_by', sortBy);
  }, [sortBy]);
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

  // Sync bottom panels (OCR + Faces) with the selected photo
  // Guard ref para evitar loops: só atualiza se o path realmente mudou
  const lastSelectedPathRef = useRef('');

  useEffect(() => {
    if (!selectedPhotoPath) {
      if (lastSelectedPathRef.current !== '') {
        lastSelectedPathRef.current = '';
        setSelectedPhotoOcr(null);
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

    const fileName = selectedPhotoPath.split(/[\\/]/).pop() || '';
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

    // ── VERIFICAR CACHE OCR ──
    const cached = ocrCacheRef.current[selectedPhotoPath];
    if (cached) {
      setSelectedPhotoOcr(prev =>
        prev?.path === selectedPhotoPath ? prev : cached
      );
      fetchFaces();
      return;
    }

    // ── ESTADO INICIAL: LOADING ──
    setSelectedPhotoOcr(prev => {
      if (prev?.path === selectedPhotoPath && prev?.status === 'loading') return prev;
      return { path: selectedPhotoPath, fileName, status: 'loading' };
    });

    setSelectedPhotoFaces({ status: 'processing', faces: [] });

    // ── CHAMAR OCR ENDPOINT ──
    fetch(`/api/scanner/preview-ocr?path=${encodeURIComponent(selectedPhotoPath)}`, {
      signal: controller.signal,
    })
      .then(r => r.json())
      .then(data => {
        if (controller.signal.aborted) return;

        const normalized: SelectedPhotoOcrData = {
          path: selectedPhotoPath,
          fileName,
          status: data.ok && data.raw_text ? 'done' : 'empty',
          rawText: data.raw_text || '',
          fields: data.fields || {},
          confidence: data.confidence ?? null,
        };

        ocrCacheRef.current[selectedPhotoPath] = normalized;

        setSelectedPhotoOcr(prev =>
          prev?.path === selectedPhotoPath && prev?.status === normalized.status
            ? prev
            : normalized
        );
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        setSelectedPhotoOcr({
          path: selectedPhotoPath,
          fileName,
          status: 'error',
          error: String(err),
        });
      });

    // ── FACES ──
    fetchFaces();

    return () => {
      controller.abort();
    };
  }, [selectedPhotoPath]);

  const handlePickOri = async () => {
    const res = await api.selectFolder().catch(() => null);
    if (res?.path) setOriPath(res.path);
  };

  const handlePickRef = async () => {
    const res = await api.selectFolder().catch(() => null);
    if (res?.path) {
      setRefPath(res.path);
      try {
        const [photos, tree] = await Promise.all([
          api.explorePhotos(res.path, { recursive: true, limit: 0, include_raw: true }),
          api.exploreTree(res.path, 2),
        ]);
        const subfolderCount = tree.tree
          ? (Array.isArray(tree.tree) ? tree.tree : [tree.tree]).reduce((acc: number, n: any) => {
              const count = (n.children?.length || 0);
              return acc + count;
            }, 0)
          : 0;
        setRefPathInfo({
          photos: photos.total || 0,
          subfolders: subfolderCount,
        });
      } catch {
        setError('Erro ao carregar estatísticas da pasta de referência.');
      }
    }
  };

  const handleAddEventFolder = async () => {
    const res = await api.selectFolder().catch(() => null);
    if (res?.path && !eventFolders.includes(res.path)) {
      setEventFolders(prev => [...prev, res.path]);
      try {
        const tree = await api.exploreTree(res.path, 3);
        const allSub: string[] = [];
        const flatten = (nodes: any[], parent = '') => {
          nodes.forEach((n: any) => {
            const full = parent ? `${parent}/${n.name}` : n.name;
            allSub.push(full);
            if (n.children) flatten(n.children, full);
          });
        };
        if (tree.tree) flatten(Array.isArray(tree.tree) ? tree.tree : [tree.tree]);
        const statuses: Record<string, 'include' | 'ignore' | 'monitor'> = {};
        allSub.forEach(p => { statuses[p] = 'include'; });
        setEventFolderStatuses(prev => ({ ...prev, [res.path]: statuses }));
      } catch { /* tree best-effort */ }
    }
  };

  const handleEventFolderStatus = (folderPath: string, subPath: string, status: 'include' | 'ignore' | 'monitor') => {
    setEventFolderStatuses(prev => {
      const folder = { ...(prev[folderPath] || {}) };
      folder[subPath] = status;
      return { ...prev, [folderPath]: folder };
    });
  };

  const handleRemoveEventFolder = (idx: number) => {
    setEventFolders(prev => prev.filter((_, i) => i !== idx));
  };

  const startPolling = useCallback(() => {
    setPolling(true);
    const poll = async () => {
      try {
        const st = await api.getScanStatus();
        setScanStatus(st);
        
        if (st.is_scanning) {
          setIsScanning(true);
          
          if (st.current_photo?.path) {
            const photoPath = st.current_photo.path;
            
            // Atualizar processedPhotos (carrossel recente)
            if (!processedPhotos.includes(photoPath)) {
              setProcessedPhotos(prev => [photoPath, ...prev].slice(0, 100));
            }

            // Forçar visualização live se estiver em grid ou modo específico
            // mas sem resetar zoom se o usuário estiver navegando manualmente
            if (activePhotoIndex === 0 || !selectedPhotoPath) {
              setActivePhotoIndex(0);
            }

            // Atualizar faces em tempo real
            if (st.current_photo.faces) {
              setLiveFaceBoxes(st.current_photo.faces);
            }

            // Atualizar OCR em tempo real
            if (st.current_photo.ocr_text) {
              setSelectedPhotoOcr({
                path: photoPath,
                status: 'done',
                fileName: st.current_photo.name || photoPath.split(/[\\/]/).pop() || '',
                raw_text: st.current_photo.ocr_text,
                fields: { numero: st.current_photo.ocr_text },
                confidence: 0.95
              });
            }
          }

          if (Math.random() > 0.8 && st.current_photo?.name) {
            setTimeline(prev => [
              ...prev.slice(-49),
              { 
                id: Date.now().toString(), 
                kind: 'system', 
                text: `Processando: ${st.current_photo?.name || 'foto'}...`, 
                timestamp: Date.now() 
              }
            ]);
          }
        }

        if (!st.is_scanning && isScanning) {
          setIsScanning(false);
          setPolling(false);
          if (pollRef.current) clearInterval(pollRef.current);
          if (st.stopped) {
            setIsCompleted(false);
            setTimeline(prev => [...prev, { id: `stopped-${Date.now()}`, kind: 'warning', text: 'Escaneamento interrompido.', timestamp: Date.now() }]);
          } else {
            setIsCompleted(true);
            setTimeline(prev => [...prev, { id: `end-${Date.now()}`, kind: 'summary', text: 'Escaneamento finalizado.', timestamp: Date.now() }]);
          }
        }
      } catch { /* ignore */ }
    };
    poll();
    pollRef.current = setInterval(poll, 1000);

    const pollMetrics = async () => {
      try {
        const m = await api.getSystemMetrics();
        setSystemMetrics(m);
      } catch { /* ignore */ }
    };
    pollMetrics();
    metricsPollRef.current = setInterval(pollMetrics, 2000);
  }, [isScanning, processedPhotos]);

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
            let sorted = [...res.photos];
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
    setSelectedFolder(oriPath);
  }, [oriPath]);

  useEffect(() => {
    return () => { 
      if (pollRef.current) clearInterval(pollRef.current); 
      if (metricsPollRef.current) clearInterval(metricsPollRef.current); 
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

  // Sincronizar selectedEventFolders quando a pasta de evento mudar ou o catálogo mudar
  useEffect(() => {
    if (eventFolders.length > 0 && catalogName) {
      const path = eventFolders[eventFolders.length - 1];
      const key = `scanner:eventFolders:${catalogName}:${path}`;
      const saved = localStorage.getItem(key);
      if (saved) {
        try {
          setSelectedEventFolders(JSON.parse(saved));
        } catch (e) {
          console.error('Erro ao ler pastas selecionadas do cache', e);
        }
      }
    }
  }, [eventFolders, catalogName]);



  const handleScan = async () => {
    if (!oriPath) { setError('Selecione a pasta de origem.'); return; }
    const name = newCatalogMode ? newCatalogName.trim() : catalogName;
    if (!name) { setError('Selecione ou crie um catálogo.'); return; }
    
    setError('');
    setStarting(true);
    setIsScanning(true);
    setIsCompleted(false);
    setTimeline([{ id: `start-${Date.now()}`, kind: 'system', text: `Scanner PRO v2.1 iniciado em ${new Date().toLocaleTimeString()}`, timestamp: Date.now() }]);
    
    try {
      const payload = {
        ai_model: aiModel,
        ocr_hybrid_enabled: ocrEnabled,
        face_detection_enabled: faceRecEnabled,
        min_quality: quality,
        blur_treatment: blurFilter,
        selected_folders: selectedEventFolders,
      };

      console.log("[Scanner Start Payload]", payload);

      await api.scanFolder(oriPath, refPath || '', name, payload);
      await setCatalog(name);
      await refreshCatalogs();
      startPolling();
    } catch (err) {
      setError('Erro ao iniciar o scan.');
      setIsScanning(false);
      setStarting(false);
    }
  };

  const handleStopScan = async () => {
    // 1. Parar polling IMEDIATAMENTE antes de qualquer chamada
    setIsScanning(false);
    setStarting(false);
    setPolling(false);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (metricsPollRef.current) { clearInterval(metricsPollRef.current); metricsPollRef.current = null; }
    setTimeline(prev => [...prev, {
      id: `stop-${Date.now()}`,
      kind: 'warning',
      text: 'Scanner interrompido com segurança.',
      timestamp: Date.now()
    }]);

    // 2. Chamar backend para cancelamento real (não bloquear UI)
    try {
      await api.scannerStop();
    } catch { /* fallback */ }
    try {
      await api.stopScan();
    } catch { /* ignore */ }
  };

  const handleCreateCatalog = async () => {
    const name = newCatalogName.trim();
    if (!name) return;
    try {
      await api.setCatalog(name);
      await refreshCatalogs();
      setCatalogName(name);
      setNewCatalogName('');
      setShowNewCatalogInput(false);
    } catch {
      setError('Erro ao criar catálogo.');
    }
  };

  const progressPct = scanStatus ? Math.min(100, Math.max(0, (scanStatus.total_processadas / (scanStatus.total_files || 1)) * 100)) : 0;
  const etaStr = scanStatus?.eta_seconds ? new Date(scanStatus.eta_seconds * 1000).toISOString().substr(11, 8) : '00:00:00';

  const navPreviewUrl = activePhotos[activePhotoIndex] ? api.thumbUrl(activePhotos[activePhotoIndex], 1200) : '';
  const navFileName = activePhotos[activePhotoIndex]?.split(/[\\/]/).pop() || '';

  const navigatePreview = (dir: number) => {
    const next = activePhotoIndex + dir;
    if (next >= 0 && next < activePhotos.length) {
      setPreviewLoaded(false);
      setActivePhotoIndex(next);
      setPreviewZoom(0);
      setDragPos({ x: 0, y: 0 });
    }
  };

  const handleDragStart = (e: React.MouseEvent) => {
    if (previewZoom <= 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - dragPos.x, y: e.clientY - dragPos.y });
  };

  const handleDragMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setDragPos({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  const sidebarCollapsedContent = (
    <div className={styles.sidebarIcons}>
      <button className={`${styles.sidebarIconBtn} ${isScanning ? styles.sidebarIconStart : ''}`} onClick={handleScan} title="Iniciar Scanner">
        {starting && isScanning ? <LoaderCircle size={18} className={styles.spin} /> : <Zap size={18} fill="currentColor" />}
      </button>
      <div className={styles.sidebarIconDivider} />
      <button className={styles.sidebarIconBtn} title="Origem"><Folder size={18} /></button>
      <button className={styles.sidebarIconBtn} title="IA"><Cpu size={18} /></button>
      <button className={styles.sidebarIconBtn} title="OCR"><Maximize2 size={18} /></button>
    </div>
  );

  const CircularGauge = ({ pct }: { pct: number }) => {
    const radius = 38;
    const circ = 2 * Math.PI * radius;
    const offset = circ - (pct / 100) * circ;
    return (
      <div className={styles.gaugeContainer}>
        <svg width="100" height="100" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r={radius} fill="none" stroke="#1a1c23" strokeWidth="5" />
          <circle 
            cx="50" cy="50" r={radius} fill="none" stroke="#3b82f6" strokeWidth="5" 
            strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
            transform="rotate(-90 50 50)"
            style={{ transition: 'stroke-dashoffset 0.5s ease' }}
          />
        </svg>
        <div className={styles.gaugeText}>
          <span className={styles.gaugePct}>{Math.round(pct)}%</span>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.workspace}>
      {/* ── TOP SUMMARY BAR ── */}
      <div className={styles.summaryBar}>
        <div className={styles.summaryHeader}>
          <h1>Scanner PRO</h1>
          <p>Ingestão inteligente com IA e OCR</p>
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
          <div className={styles.summaryStat}>
            <span className={styles.statLabel}>Tempo estimado</span>
            <span className={styles.statValue}>
              {scanStatus?.eta_seconds === -1 ? 'Calculando...' : 
               scanStatus?.eta_seconds ? etaStr : '--'}
              {scanStatus?.eta_seconds ? <span className={styles.statSub}>restante</span> : null}
            </span>
          </div>
        </div>

        <div className={styles.summaryActions}>
          <button className={styles.pauseBtn} onClick={() => setIsFeedPaused(!isFeedPaused)}>
            {isFeedPaused ? <Play size={12} /> : <Pause size={12} />}
            {isFeedPaused ? 'Retomar' : 'Pausar'}
          </button>
          <button className={styles.stopBtn} onClick={handleStopScan} disabled={!isScanning}>
            <X size={12} /> Parar
          </button>
        </div>
      </div>

      <div className={styles.mainLayout}>
        {/* ── LEFT PANEL: CONFIG ── */}
        <div className={`${styles.leftPanel} ${sidebarCollapsed ? styles.leftPanelCollapsed : ''}`}>
          <div className={styles.leftPanelTop}>
            <button className={styles.leftPanelToggle} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
              {sidebarCollapsed ? <ChevronRightIcon size={14} /> : <ChevronLeft size={14} />}
            </button>
          </div>

          {sidebarCollapsed ? sidebarCollapsedContent : (
            <>
              <div className={styles.leftPanelScroll}>
                
                <CollapsibleSection title="1. Origem" icon={Folder}>
                  <div className={styles.formGroup}>
                    <label className={styles.fieldLabel}>Pasta de origem</label>
                    <div className={styles.inputActionRow}>
                      <input 
                        className={styles.darkInput} 
                        placeholder="Nenhuma pasta selecionada"
                        value={oriPath}
                        readOnly
                      />
                      <button className={styles.actionBtn} onClick={handlePickOri}>
                        <FolderOpen size={12} /> Alterar
                      </button>
                    </div>
                  </div>
                  
                  <div className={styles.formGroup} style={{ marginTop: 8 }}>
                    <label className={styles.fieldLabel}>Estrutura Detectada</label>
                    <FolderTree 
                      rootPath={oriPath} 
                      onSelectFolder={setSelectedFolder} 
                      selectedPath={selectedFolder}
                    />
                  </div>
                  <div className={styles.checkboxGroup} style={{ marginTop: 10 }} onClick={() => setRawEnabled(!rawEnabled)}>
                    <div className={`${styles.checkbox} ${rawEnabled ? styles.checked : ''}`}>
                      {rawEnabled && <Check size={10} color="white" />}
                    </div>
                    <span className={styles.checkboxLabel}>Incluir arquivos RAW</span>
                  </div>
                  <div className={styles.checkboxGroup} onClick={() => setRecursiveEnabled(!recursiveEnabled)}>
                    <div className={`${styles.checkbox} ${recursiveEnabled ? styles.checked : ''}`}>
                      {recursiveEnabled && <Check size={10} color="white" />}
                    </div>
                    <span className={styles.checkboxLabel}>Incluir subpastas (Recursivo)</span>
                  </div>
                </CollapsibleSection>

                {/* ── SECTION 2: CATÁLOGO ── */}
                <div className={styles.refEventSection}>
                  <div className={styles.sectionHeader}>
                    <Database size={14} className={styles.manageBtnIcon} />
                    <span className={styles.sectionTitle}>2. Catálogo</span>
                  </div>

                  <label className={styles.fieldLabel}>Nome do Catálogo</label>
                  <div className={styles.inputActionRow}>
                    <input
                      className={styles.darkInput}
                      placeholder="Digite o nome do novo catálogo"
                      value={catalogName}
                      onChange={e => setCatalogName(e.target.value)}
                    />
                    <button className={styles.actionBtn} onClick={() => setShowNewCatalogInput(true)} title="Ver catálogos existentes">
                      <Database size={12} /> Selecionar
                    </button>
                  </div>
                  <p className={styles.fieldDescription}>
                    Digite o nome para o novo catálogo ou selecione um existente.
                  </p>
                </div>

                {/* ── SECTION 3: REFERÊNCIA ── */}
                <div className={styles.refEventSection}>
                  <div className={styles.sectionHeader}>
                    <Folder size={14} className={styles.manageBtnIcon} />
                    <span className={styles.sectionTitle}>3. Pasta de referência</span>
                  </div>
                  
                  <label className={styles.fieldLabel}>Pasta de referência / Evento</label>
                  <div className={styles.inputActionRow}>
                    <input 
                      className={styles.darkInput} 
                      placeholder="Nenhuma pasta selecionada"
                      value={refPath}
                      readOnly
                    />
                    <button className={styles.actionBtn} onClick={handlePickRef}>
                      <Folder size={12} /> Alterar
                    </button>
                  </div>
                  <p className={styles.fieldDescription}>
                    Usada para referência de rostos, comparação ou pastas auxiliares.
                  </p>
                  {refPathInfo && (
                    <div className={styles.refStats}>
                      <ImageIcon size={10} />
                      <span>{refPathInfo.photos.toLocaleString('pt-BR')} imagens detectadas</span>
                    </div>
                  )}
                </div>

                {/* ── SECTION 4: EVENTOS ── */}
                <div className={styles.refEventSection}>
                  <div className={styles.sectionHeader}>
                    <Calendar size={14} className={styles.manageBtnIcon} />
                    <span className={styles.sectionTitle}>4. Eventos</span>
                  </div>

                  <label className={styles.fieldLabel}>Pasta de eventos</label>
                  <div className={styles.inputActionRow}>
                    <input 
                      className={styles.darkInput} 
                      placeholder="Nenhuma pasta selecionada"
                      value={eventFolders.length > 0 ? eventFolders[eventFolders.length - 1] : ''}
                      readOnly
                    />
                    <button className={styles.actionBtn} onClick={handleAddEventFolder}>
                      <Folder size={12} /> Alterar
                    </button>
                  </div>
                  <p className={styles.fieldDescription}>
                    Pasta principal do evento. Selecione para gerenciar as subpastas incluídas.
                  </p>

                  <button 
                    className={styles.manageBtn} 
                    onClick={() => setShowEventManager(!showEventManager)}
                  >
                    <div className={styles.manageBtnContent}>
                      <FolderSearch size={14} className={styles.manageBtnIcon} />
                      <span>Gerenciar eventos e subpastas</span>
                    </div>
                    <ChevronRightIcon size={12} className={`${styles.manageBtnChevron} ${showEventManager ? styles.chevronOpen : ''}`} />
                  </button>

                  {showEventManager && eventFolders.length > 0 && (
                    <ScannerEventFolderManager 
                      eventPath={eventFolders[eventFolders.length - 1]}
                      catalogName={catalogName || 'default'}
                      onClose={() => setShowEventManager(false)}
                      onApply={(selectedPaths) => {
                        setSelectedEventFolders(selectedPaths);
                        setShowEventManager(false);
                      }}
                    />
                  )}

                  
                  {eventPhotosCountStatus === 'loading' && (
                    <div className={styles.refStats}>
                      <LoaderCircle size={10} className={styles.spin} />
                      <span>Contando imagens...</span>
                    </div>
                  )}
                  {eventPhotosCountStatus === 'error' && (
                    <div className={styles.refStats} style={{ color: '#ef4444' }}>
                      <AlertTriangle size={10} />
                      <span>Não foi possível contar imagens</span>
                    </div>
                  )}
                  {eventPhotosCountStatus === 'done' && eventPhotosCount > 0 && (
                    <div className={styles.refStats}>
                      <ImageIcon size={10} />
                      <span>{eventPhotosCount.toLocaleString('pt-BR')} imagens detectadas</span>
                    </div>
                  )}
                  {eventPhotosCountStatus === 'none' && (
                    <div className={styles.refStats} style={{ color: '#5a6577' }}>
                      <span>Nenhuma pasta selecionada</span>
                    </div>
                  )}

                </div>

                <CollapsibleSection title="5. IA e OCR" icon={Sparkles}>

                  <div className={styles.formGroup}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <label className={styles.label}>Modelo</label>
                      <span className={`${styles.badge} ${styles.badgeBlue}`}>v2.1 PRO</span>
                    </div>
                    <select className={styles.inputBase} value={aiModel} onChange={e => setAiModel(e.target.value)}>
                      <option>FormaturaPRO - High Quality</option>
                    </select>
                  </div>
                  <div className={styles.checkboxGroup} onClick={() => setOcrEnabled(!ocrEnabled)}>
                    <div className={`${styles.checkbox} ${ocrEnabled ? styles.checked : ''}`}>
                      {ocrEnabled && <Check size={10} color="white" />}
                    </div>
                    <span className={styles.checkboxLabel}>OCR Híbrido Ativo</span>
                  </div>
                  <div className={styles.checkboxGroup} onClick={() => setFaceRecEnabled(!faceRecEnabled)}>
                    <div className={`${styles.checkbox} ${faceRecEnabled ? styles.checked : ''}`}>
                      {faceRecEnabled && <Check size={10} color="white" />}
                    </div>
                    <span className={styles.checkboxLabel}>Detecção de Rostos</span>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection title="6. Qualidade" icon={SlidersHorizontal}>
                  <div className={styles.formGroup}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <label className={styles.label}>Mínima</label>
                      <span className={styles.sliderValue}>{quality}%</span>
                    </div>
                    <input type="range" className={styles.slider} min="50" max="100" value={quality} onChange={e => setQuality(parseInt(e.target.value))} />
                  </div>
                  <div className={styles.formGroup}>
                    <label className={styles.label}>Tratamento de desfoque</label>
                    <select className={styles.inputBase} value={blurFilter} onChange={e => setBlurFilter(e.target.value)}>
                      <option>Filtro Médio</option>
                      <option>Filtro Rigoroso</option>
                    </select>
                  </div>
                </CollapsibleSection>
              </div>

              <div className={styles.leftPanelBottom}>
                <div className={styles.presetRow}>
                  <button className={styles.destBtn} style={{ flex: 1 }}><Folder size={12} /> Carregar</button>
                  <button className={styles.destBtn} style={{ flex: 1 }}><Database size={12} /> Salvar</button>
                </div>
                <button 
                  className={`${styles.startBtn} ${!isScanning && oriPath ? styles.startBtnPulse : ''}`} 
                  onClick={handleScan} 
                  disabled={isScanning || !oriPath}
                >
                  {starting && isScanning ? <LoaderCircle size={16} className={styles.spin} /> : <Zap size={16} fill="currentColor" />}
                  {isScanning ? 'PROCESSANDO...' : 'INICIAR SCANNER'}
                </button>
              </div>
            </>
          )}
        </div>

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
                  <button className={styles.toggleBtn} onClick={() => { setPreviewZoom(0); setDragPos({x:0, y:0}); }} title="Fit Screen" style={{ marginLeft: 8 }}>
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
                          onChange={e => setSortBy(e.target.value as any)}
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
                      ref={imgRef}
                      key={activePhotos[activePhotoIndex]}
                      src={navPreviewUrl} 
                      className={`${styles.previewImage} ${previewLoaded ? styles.previewImageLoaded : styles.previewImageLoading}`} 
                      alt={navFileName}
                      onLoad={(e) => {
                        setPreviewLoaded(true);
                        const img = e.currentTarget;
                        setNaturalDims({ w: img.naturalWidth, h: img.naturalHeight });
                      }}
                      draggable={false}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
                    />
                    {naturalDims.w > 0 && liveFaceBoxes.length > 0 && (
                      <svg
                        className={styles.faceOverlaySvg}
                        viewBox={`0 0 ${naturalDims.w} ${naturalDims.h}`}
                        preserveAspectRatio="xMidYMid meet"
                      >
                        {liveFaceBoxes.slice(0, 50).map((f, i) => {
                          const [x1, y1, x2, y2] = f.bbox;
                          return (
                            <g key={i}>
                              <rect
                                x={x1} y={y1}
                                width={x2 - x1} height={y2 - y1}
                                className={styles.faceBox}
                              />
                              {f.confidence > 0 && (
                                <text
                                  x={x1 + 4} y={y1 + 14}
                                  className={styles.faceLabel}
                                >
                                  {`${Math.round(f.confidence * 100)}%`}
                                </text>
                              )}
                            </g>
                          );
                        })}
                      </svg>
                    )}
                  </div>
                </div>
              </div>

              <div 
                className={styles.singleFilmstrip}
                ref={filmstripRef}
                onWheel={(e) => {
                  if (filmstripRef.current) {
                    filmstripRef.current.scrollLeft += e.deltaY;
                    e.preventDefault();
                  }
                }}
              >
                {activePhotos.map((p, i) => {
                  if (Math.abs(i - activePhotoIndex) > 30) return null;
                  return (
                    <div 
                      key={p} 
                      className={`${styles.singleFilmstripCard} ${i === activePhotoIndex ? styles.singleFilmstripCardActive : ''}`}
                      onClick={() => {
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
                            setViewMode('single');
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
                <PhotoCard 
                  key={`${path}-${i}`} 
                  path={path} 
                  isActive={activePhotos.indexOf(path) === activePhotoIndex}
                  onClick={handleCardClick}
                  onDoubleClick={handleCardDoubleClick}
                />
              ))}

              {!isLoadingPhotos && !isScanning && filteredFolderPhotos.map((photo, i) => (
                <PhotoCard 
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
                <span className={styles.detailTitle}><Search size={11} /> OCR / Texto detectado</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {selectedPhotoOcr ? (
                    <span className={styles.ocrBadge}>
                      {selectedPhotoOcr.status === 'loading' ? (
                        <LoaderCircle size={8} className={styles.spin} />
                      ) : (
                        <Eye size={8} />
                      )}
                      {selectedPhotoOcr.status === 'loading' ? 'LENDO OCR...' : 
                       selectedPhotoOcr.status === 'done' ? 'OCR DETECTADO' :
                       selectedPhotoOcr.status === 'empty' ? 'SEM TEXTO' :
                       selectedPhotoOcr.status === 'error' ? 'ERRO OCR' : 'AGUARDANDO'}
                    </span>
                  ) : null}
                </div>
              </div>
              {selectedPhotoOcr ? (
                <div className={styles.ocrGrid}>
                  <span className={styles.ocrLabel}>Arquivo:</span>
                  <span className={styles.ocrValue} title={selectedPhotoOcr.fileName}>
                    {selectedPhotoOcr.fileName.length > 30
                      ? selectedPhotoOcr.fileName.slice(0, 27) + '...'
                      : selectedPhotoOcr.fileName}
                  </span>
                  <span className={styles.ocrLabel}>Nome:</span>
                  <span className={selectedPhotoOcr.fields?.nome ? styles.ocrValueFound : styles.ocrValue}>
                    {selectedPhotoOcr.status === 'loading' ? 'Lendo...' :
                     selectedPhotoOcr.fields?.nome || '---'}
                    {selectedPhotoOcr.confidence ? <span className={styles.ocrConfidence}>{Math.round(selectedPhotoOcr.confidence * 100)}%</span> : null}
                  </span>
                  <span className={styles.ocrLabel}>Curso:</span>
                  <span className={selectedPhotoOcr.fields?.curso ? styles.ocrValueFound : styles.ocrValue}>
                    {selectedPhotoOcr.status === 'loading' ? 'Lendo...' :
                     selectedPhotoOcr.fields?.curso || '---'}
                  </span>
                  <span className={styles.ocrLabel}>Instituição:</span>
                  <span className={styles.ocrValue}>
                    {selectedPhotoOcr.status === 'loading' ? 'Lendo...' :
                     selectedPhotoOcr.fields?.instituicao || '---'}
                  </span>
                  <span className={styles.ocrLabel}>Data:</span>
                  <span className={styles.ocrValue}>
                    {selectedPhotoOcr.status === 'loading' ? 'Lendo...' :
                     selectedPhotoOcr.fields?.data || '---'}
                  </span>
                  <span className={styles.ocrLabel}>Tipo:</span>
                  <span className={styles.ocrValue}>
                    {selectedPhotoOcr.status === 'loading' ? 'Lendo...' :
                     selectedPhotoOcr.fields?.tipo || '---'}
                  </span>
                  <span className={styles.ocrLabel}>Nº OCR:</span>
                  <span className={styles.ocrValue}>
                    {selectedPhotoOcr.status === 'loading' ? 'Lendo...' :
                     selectedPhotoOcr.fields?.numero || '---'}
                  </span>
                </div>
              ) : (
                <div className={styles.ocrEmpty}>
                  {activePhotos.length > 0
                    ? 'Aguardando dados de OCR...'
                    : 'Selecione uma foto para ver dados de OCR'}
                </div>
              )}
            </div>
            <div className={styles.detailSection}>
              <div className={styles.detailHeader}>
                <span className={styles.detailTitle}><ScanFace size={11} /> Rostos detectados</span>
                <span className={styles.detailCount}>
                  {selectedPhotoFaces.status === 'waiting' ? '-' : `${selectedPhotoFaces.faces.length} rostos`}
                </span>
              </div>
              {selectedPhotoFaces.status === 'waiting' || selectedPhotoFaces.faces.length === 0 ? (
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
                            face.badge === 'ocr' ? `${styles.badge} ${styles.badgeBlue}` :
                            face.badge === 'ia' ? `${styles.badge} ${styles.badgeAmber}` :
                            face.badge === 'similar' ? `${styles.badge} ${styles.badgeGreen}` :
                            `${styles.badge} ${styles.badgePurple}`
                          } style={{ fontSize: 6, padding: '1px 4px', borderRadius: 3 }}>
                            {face.badge === 'ocr' ? 'OCR' : face.badge === 'ia' ? 'IA' : face.badge === 'similar' ? 'Similar' : 'Sem match'}
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
            <div className={styles.gaugeContainer}>
              <CircularGauge pct={progressPct} />
            </div>
            <div className={styles.progressInfo}>
              <span className={styles.progressCount}>
                {new Intl.NumberFormat('pt-BR').format(scanStatus?.total_processadas || 0)} / {new Intl.NumberFormat('pt-BR').format(scanStatus?.total_fotos || 0)}
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
                <div className={styles.queueLabel}><div className={styles.dot} style={{ background: '#0ea5e9' }} /> OCR</div>
                <div className={styles.queueValue}><span>{new Intl.NumberFormat('pt-BR').format(Math.floor((scanStatus?.total_processadas || 0) * 0.9))}</span></div>
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
              <button className={styles.alterBtn} style={{ height: 20, fontSize: 8 }} onClick={() => setTimeline([])}>Limpar</button>
            </div>
            <div className={styles.logBox}>
              {timeline.length > 0 ? timeline.slice().reverse().map(entry => (
                <div key={entry.id} className={styles.logEntry}>
                  <span className={styles.logTime}>{new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })}</span>
                  <span className={styles.logText} style={{ color: entry.kind === 'error' ? '#f87171' : entry.kind === 'warning' ? '#fbbf24' : '#6b7a8e' }}>{entry.text}</span>
                </div>
              )) : (
                <div className={styles.logEmpty}>Nenhum log no momento</div>
              )}
            </div>
          </div>

          <div className={styles.systemMetrics}>
            <div className={styles.metricItem}>
              <Monitor size={12} className={styles.metricIcon} />
              <span className={styles.metricLabel}>GPU Load</span>
              <span className={styles.metricValue}>{systemMetrics?.gpuLoad != null ? `${systemMetrics.gpuLoad}%` : '--'}</span>
            </div>
            <div className={styles.metricItem}>
              <Cpu size={12} className={styles.metricIcon} />
              <span className={styles.metricLabel}>CPU Load</span>
              <span className={styles.metricValue}>{systemMetrics?.cpuLoad != null ? `${systemMetrics.cpuLoad}%` : '--'}</span>
            </div>
            <div className={styles.metricItem}>
              <HardDrive size={12} className={styles.metricIcon} />
              <span className={styles.metricLabel}>RAM</span>
              <span className={styles.metricValue}>{systemMetrics?.ramUsedGb != null ? `${systemMetrics.ramUsedGb.toFixed(1)}GB` : '--'}</span>
            </div>
            <div className={styles.metricItem}>
              <Zap size={12} className={styles.metricIcon} />
              <span className={styles.metricLabel}>Temp</span>
              <span className={styles.metricValue}>{systemMetrics?.tempC != null ? `${systemMetrics.tempC}°C` : '--'}</span>
            </div>
          </div>
        </div>
      </div>

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
    </div>
  );
});

const HIDDEN_DIRS = new Set(['.cache', '.temp', '__pycache__', 'thumbs', 'thumbnails']);

const EventFolderItem = memo(({
  path: folderPath,
  statuses,
  onStatusChange,
  onRemove,
}: {
  path: string;
  statuses: Record<string, 'include' | 'ignore' | 'monitor'>;
  onStatusChange: (subPath: string, status: 'include' | 'ignore' | 'monitor') => void;
  onRemove: () => void;
}) => {
  const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath;
  const entries = Object.entries(statuses).filter(([k]) => !HIDDEN_DIRS.has(k.toLowerCase().split('/').pop() || ''));
  const included = entries.filter(([, v]) => v === 'include').length;
  const ignored = entries.filter(([, v]) => v === 'ignore').length;

  return (
    <div className={styles.eventFolderCard}>
      <div className={styles.eventFolderHeader}>
        <Folder size={12} className={styles.eventFolderIcon} />
        <span className={styles.eventFolderName}>{folderName}</span>
        <span className={styles.eventFolderCount}>{entries.length} subpastas</span>
        <button className={styles.eventFolderRemove} onClick={onRemove} title="Remover pasta">
          <X size={10} />
        </button>
      </div>
      <div className={styles.eventFolderSubList}>
        {entries.map(([subPath, status]) => (
          <div key={subPath} className={styles.eventFolderSubRow}>
            <span className={styles.eventFolderSubName}>{subPath}</span>
            <div className={styles.eventFolderSubActions}>
              {(['include', 'ignore', 'monitor'] as const).map(s => (
                <button
                  key={s}
                  className={`${styles.eventSubBtn} ${status === s ? styles[`eventSubBtn${s.charAt(0).toUpperCase() + s.slice(1)}`] : ''}`}
                  onClick={() => onStatusChange(subPath, s)}
                  title={s === 'include' ? 'Incluir' : s === 'ignore' ? 'Ignorar' : 'Monitorar'}
                >
                  {s === 'include' ? <Check size={10} /> : s === 'ignore' ? <X size={10} /> : <Eye size={10} />}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className={styles.eventFolderFooter}>
        <Check size={10} className={styles.eventFolderFooterIcon} />
        <span>{included} incluídas</span>
        {ignored > 0 && <><X size={10} className={styles.eventFolderFooterIcon} /><span>{ignored} ignoradas</span></>}
      </div>
    </div>
  );
});

const RAW_EXTENSIONS = ['cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'dng', 'raf'];

const PhotoCard = memo(({ 
  path, 
  ext,
  isActive,
  onClick,
  onDoubleClick
}: { 
  path: string, 
  ext?: string,
  isActive: boolean,
  onClick: (path: string) => void,
  onDoubleClick: (path: string) => void
}) => {
  const fileExt = (ext || path.split('.').pop() || '').toLowerCase().replace('.', '');
  const isRawFile = RAW_EXTENSIONS.includes(fileExt);
  const [imgError, setImgError] = useState(false);

  return (
    <div 
      className={`${styles.photoCard} ${isActive ? styles.photoCardActive : ''}`}
      onClick={() => onClick(path)}
      onDoubleClick={() => onDoubleClick(path)}
    >
      {imgError && isRawFile ? (
        <div className={styles.rawPlaceholder}>
          <ImageIcon size={24} className={styles.rawIcon} />
          <span className={styles.rawLabel}>RAW</span>
          <span className={styles.rawSub}>sem prévia</span>
        </div>
      ) : (
        <img 
          src={api.thumbUrl(path, 300)} 
          alt="Preview" 
          className={styles.cardThumb} 
          loading="lazy"
          onError={() => setImgError(true)}
        />
      )}
      <div className={styles.cardOverlays}>
        <div className={styles.overlayTop}>
          <div className={styles.statsBadge}>
            <div className={styles.statIcon}><ScanFace size={10} /> IA</div>
          </div>
          {isRawFile && <div className={`${styles.badge} ${styles.badgeAmber}`} style={{ fontSize: 7, marginLeft: 4 }}>RAW</div>}
        </div>
        <div className={styles.overlayBottom}>
          <div className={styles.extBadge}>{fileExt.toUpperCase() || 'JPG'}</div>
        </div>
      </div>
    </div>
  );
});

export default ScannerWorkspace;
