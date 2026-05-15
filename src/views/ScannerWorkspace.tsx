import { useState, useEffect, useCallback, useRef, memo, useMemo } from 'react';
import { 
  FolderOpen, Scan, X, Plus, Cpu, ScanFace, Layers3, Sparkles, 
  Maximize2, LayoutGrid, Search, Info, AlertTriangle, Blocks, Wand2, 
  CheckCircle2, Circle, Database, Terminal, Zap, Gauge, Activity, 
  Play, Pause, Folder, LoaderCircle, ChevronDown, List, SlidersHorizontal,
  HardDrive, Monitor, MousePointer2, Users, Eye, ChevronRight as ChevronRightIcon, ChevronLeft, FolderSearch,
  Image as ImageIcon
} from 'lucide-react';
import { api, type ScanStatus, type ScanRecentFace, type ExplorerPhoto } from '../services/api';
import FolderTree from '../components/scan/FolderTree';
import { useApp } from '../context/AppContext';
import styles from './ScannerWorkspace.module.css';

interface TimelineEntry {
  id: string;
  kind: 'system' | 'face' | 'match' | 'cluster' | 'summary' | 'warning' | 'error';
  text: string;
  timestamp: number;
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
  const [catalogName, setCatalogName] = useState('');
  const [newCatalogName, setNewCatalogName] = useState('');
  const [newCatalogMode, setNewCatalogMode] = useState(false);
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
  const [ocrEnabled, setOcrEnabled] = useState(true);
  const [gpuEnabled, setGpuEnabled] = useState(true);
  const [quality, setQuality] = useState(70);
  const [rawEnabled, setRawEnabled] = useState(true);
  const [recursiveEnabled, setRecursiveEnabled] = useState(true);
  const [faceRecEnabled, setFaceRecEnabled] = useState(true);
  const [blurFilter, setBlurFilter] = useState('Médio');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [processedPhotos, setProcessedPhotos] = useState<string[]>([]);
  const [activePhotoIndex, setActivePhotoIndex] = useState(0);

  // Filter state
  const [showFilters, setShowFilters] = useState(false);
  const [filterSearch, setFilterSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'jpg' | 'raw'>('all');

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
  
  useEffect(() => {
    activePhotosRef.current = activePhotos;
  }, [activePhotos]);

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

  const handlePickOri = async () => {
    const res = await api.selectFolder().catch(() => null);
    if (res?.path) setOriPath(res.path);
  };

  const startPolling = useCallback(() => {
    setPolling(true);
    const poll = async () => {
      try {
        const st = await api.getScanStatus();
        setScanStatus(st);
        
        if (st.is_scanning) {
          setIsScanning(true);
          if (st.current_photo && !processedPhotos.includes(st.current_photo)) {
            setProcessedPhotos(prev => [st.current_photo!, ...prev].slice(0, 100));
          }

          if (Math.random() > 0.8) {
            setTimeline(prev => [
              ...prev.slice(-49),
              { 
                id: Date.now().toString(), 
                kind: 'system', 
                text: `Processando: ${st.current_photo?.split('\\').pop() || 'foto'}...`, 
                timestamp: Date.now() 
              }
            ]);
          }
        }

        if (!st.is_scanning && isScanning) {
          setIsScanning(false);
          setIsCompleted(true);
          setPolling(false);
          if (pollRef.current) clearInterval(pollRef.current);
          setTimeline(prev => [...prev, { id: `end-${Date.now()}`, kind: 'summary', text: 'Escaneamento finalizado.', timestamp: Date.now() }]);
        }
      } catch { /* ignore */ }
    };
    poll();
    pollRef.current = setInterval(poll, 1000);
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
    if (currentCatalog) setCatalogName(currentCatalog);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [currentCatalog]);

  const handleScan = async () => {
    if (!oriPath) { setError('Selecione a pasta de origem.'); return; }
    const name = newCatalogMode ? newCatalogName.trim() : catalogName;
    if (!name) { setError('Informe o catálogo/evento.'); return; }
    
    setError('');
    setStarting(true);
    setIsScanning(true);
    setIsCompleted(false);
    setTimeline([{ id: `start-${Date.now()}`, kind: 'system', text: `Scanner PRO v2.1 iniciado em ${new Date().toLocaleTimeString()}`, timestamp: Date.now() }]);
    
    try {
      await api.scanFolder(oriPath, refPath || '', name);
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
    try {
      await api.stopScan();
      setIsScanning(false);
      setStarting(false);
      setTimeline(prev => [...prev, { id: `stop-${Date.now()}`, kind: 'warning', text: 'Interrompido pelo usuário.', timestamp: Date.now() }]);
    } catch (err) { /* ignore */ }
  };

  const progressPct = scanStatus ? Math.min(100, Math.max(0, (scanStatus.total_processadas / (scanStatus.total_files || 1)) * 100)) : 0;
  const etaStr = scanStatus?.eta_seconds ? new Date(scanStatus.eta_seconds * 1000).toISOString().substr(11, 8) : '00:00:00';

  const faces = useMemo(() => scanStatus?.recent_faces || [], [scanStatus]);
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
            <span className={`${styles.statValue} ${styles.warning}`}>312 <span className={styles.statSub}>2.4%</span></span>
          </div>
          <div className={styles.summaryStat}>
            <span className={styles.statLabel}>Tempo estimado</span>
            <span className={styles.statValue}>{etaStr} <span className={styles.statSub}>restante</span></span>
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
                    <label className={styles.label}>Pasta de origem</label>
                    <div className={styles.formRow}>
                      <input className={styles.inputBase} value={oriPath || 'D:\\Fotos\\Evento...'} readOnly />
                      <button className={styles.alterBtn} onClick={handlePickOri}>Alterar</button>
                    </div>
                  </div>
                  <div className={styles.formGroup}>
                    <label className={styles.label}>Estrutura Detectada</label>
                    <FolderTree 
                      rootPath={oriPath} 
                      onSelectFolder={setSelectedFolder} 
                      selectedPath={selectedFolder}
                    />
                  </div>
                  <div className={styles.formGroup}>
                    <label className={styles.label}>Ordenação</label>
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
                  <div className={styles.checkboxGroup} onClick={() => setRawEnabled(!rawEnabled)}>
                    <div className={`${styles.checkbox} ${rawEnabled ? styles.checked : ''}`}>
                      {rawEnabled && <CheckCircle2 size={10} color="white" />}
                    </div>
                    <span className={styles.checkboxLabel}>Incluir arquivos RAW</span>
                  </div>
                  <div className={styles.checkboxGroup} onClick={() => setRecursiveEnabled(!recursiveEnabled)}>
                    <div className={`${styles.checkbox} ${recursiveEnabled ? styles.checked : ''}`}>
                      {recursiveEnabled && <CheckCircle2 size={10} color="white" />}
                    </div>
                    <span className={styles.checkboxLabel}>Incluir subpastas (Recursivo)</span>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection title="2. Catálogo / Evento" icon={Database}>
                  <div className={styles.formGroup}>
                    <label className={styles.label}>Catálogo</label>
                    <div className={styles.formRow}>
                      <select className={styles.inputBase} value={catalogName} onChange={e => setCatalogName(e.target.value)}>
                        {catalogs.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <button className={styles.plusBtn}><Plus size={14} /></button>
                    </div>
                  </div>
                  <div className={styles.formGroup}>
                    <label className={styles.label}>Evento vinculado</label>
                    <div className={styles.formRow}>
                      <select className={styles.inputBase}>
                        <option>Colação - Engenharia 2024</option>
                      </select>
                    </div>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection title="3. IA e OCR" icon={Sparkles}>
                  <div className={styles.formGroup}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <label className={styles.label}>Modelo</label>
                      <span className={`${styles.badge} ${styles.badgeBlue}`}>v2.1 PRO</span>
                    </div>
                    <select className={styles.inputBase}>
                      <option>FormaturaPRO - High Quality</option>
                    </select>
                  </div>
                  <div className={styles.checkboxGroup} onClick={() => setOcrEnabled(!ocrEnabled)}>
                    <div className={`${styles.checkbox} ${ocrEnabled ? styles.checked : ''}`}>
                      {ocrEnabled && <CheckCircle2 size={10} color="white" />}
                    </div>
                    <span className={styles.checkboxLabel}>OCR Híbrido Ativo</span>
                  </div>
                  <div className={styles.checkboxGroup} onClick={() => setFaceRecEnabled(!faceRecEnabled)}>
                    <div className={`${styles.checkbox} ${faceRecEnabled ? styles.checked : ''}`}>
                      {faceRecEnabled && <CheckCircle2 size={10} color="white" />}
                    </div>
                    <span className={styles.checkboxLabel}>Detecção de Rostos</span>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection title="4. Qualidade" icon={SlidersHorizontal}>
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
                      src={navPreviewUrl} 
                      className={`${styles.previewImage} ${previewLoaded ? styles.previewImageLoaded : styles.previewImageLoading}`} 
                      alt={navFileName}
                      onLoad={() => setPreviewLoaded(true)}
                      draggable={false}
                    />
                  </div>
                </div>
              </div>

              <div className={styles.singleFilmstrip}>
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
                  <span className={styles.ocrBadge}><Eye size={8} /> Ativo</span>
                  <button className={styles.destBtn} style={{ padding: '2px 8px', fontSize: 8, height: 20 }}>Ver tudo</button>
                </div>
              </div>
              {isScanning ? (
                <div className={styles.ocrGrid}>
                  <span className={styles.ocrLabel}>Nome:</span> <span className={styles.ocrValueFound}>LARISSA ALMEIDA SOUZA <span className={styles.ocrConfidence}>98%</span></span>
                  <span className={styles.ocrLabel}>Curso:</span> <span className={styles.ocrValueFound}>ENGENHARIA CIVIL <span className={styles.ocrConfidence}>96%</span></span>
                  <span className={styles.ocrLabel}>Instituição:</span> <span className={styles.ocrValue}>UTFPR <span className={styles.ocrConfidence}>89%</span></span>
                  <span className={styles.ocrLabel}>Data:</span> <span className={styles.ocrValue}>12/12/2024 <span className={styles.ocrConfidence}>94%</span></span>
                  <span className={styles.ocrLabel}>Tipo:</span> <span className={styles.ocrValue}>COLAÇÃO DE GRAU <span className={styles.ocrConfidence}>97%</span></span>
                </div>
              ) : (
                <div className={styles.ocrEmpty}>Aguardando dados de OCR...</div>
              )}
            </div>
            <div className={styles.detailSection}>
              <div className={styles.detailHeader}>
                <span className={styles.detailTitle}><ScanFace size={11} /> Rostos detectados</span>
                <span className={styles.detailCount}>{faces.length} rostos</span>
              </div>
              <div className={styles.filmstrip}>
                {faces.map((face, i) => (
                  <div key={i} className={styles.faceCard}>
                    <div className={styles.faceImageWrap}>
                      <img src={`/api/thumb?path=${encodeURIComponent(face.path)}&x1=${face.box[0]}&y1=${face.box[1]}&x2=${face.box[2]}&y2=${face.box[3]}&size=100`} className={styles.faceImage} alt="Face" />
                    </div>
                    <div className={styles.faceMeta}>
                      <span className={styles.faceName}>{face.name || 'Identificando...'}</span>
                      <span className={styles.faceConfidence}>98.2%</span>
                    </div>
                  </div>
                ))}
              </div>
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
              <span className={styles.metricValue}>47%</span>
            </div>
            <div className={styles.metricItem}>
              <Cpu size={12} className={styles.metricIcon} />
              <span className={styles.metricLabel}>CPU Load</span>
              <span className={styles.metricValue}>32%</span>
            </div>
            <div className={styles.metricItem}>
              <HardDrive size={12} className={styles.metricIcon} />
              <span className={styles.metricLabel}>RAM</span>
              <span className={styles.metricValue}>6.2GB</span>
            </div>
            <div className={styles.metricItem}>
              <Zap size={12} className={styles.metricIcon} />
              <span className={styles.metricLabel}>Temp</span>
              <span className={styles.metricValue}>54°C</span>
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
  return (
    <div 
      className={`${styles.photoCard} ${isActive ? styles.photoCardActive : ''}`}
      onClick={() => onClick(path)}
      onDoubleClick={() => onDoubleClick(path)}
    >
      <img 
        src={api.thumbUrl(path, 300)} 
        alt="Preview" 
        className={styles.cardThumb} 
        loading="lazy"
        onError={(e) => {
          (e.target as HTMLImageElement).src = 'https://placehold.co/300x400/111/444?text=Erro+no+Preview';
        }}
      />
      <div className={styles.cardOverlays}>
        <div className={styles.overlayTop}>
          <div className={styles.statsBadge}>
            <div className={styles.statIcon}><ScanFace size={10} /> IA</div>
          </div>
        </div>
        <div className={styles.overlayBottom}>
          <div className={styles.extBadge}>{ext?.toUpperCase().replace('.', '') || 'JPG'}</div>
        </div>
      </div>
    </div>
  );
});

export default ScannerWorkspace;
