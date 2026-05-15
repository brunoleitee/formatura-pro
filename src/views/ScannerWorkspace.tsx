import { useState, useEffect, useCallback, useRef } from 'react';
import { FolderOpen, Scan, X, Plus, Info, Cpu, ScanFace, Layers3, Sparkles, Blocks, Images, Wand2, CheckCircle2, Circle, LoaderCircle, Pause, Play, UserCheck } from 'lucide-react';
import { api, type ScanStatus } from '../services/api';
import { useApp } from '../context/AppContext';
import styles from './ScannerWorkspace.module.css';

interface TimelineEntry {
  id: string;
  kind: 'system' | 'face' | 'match' | 'cluster' | 'summary' | 'warning';
  text: string;
  timestamp: number;
}

const PIPELINE = [
  { key: 'scan', label: 'Scan de pastas', icon: FolderOpen },
  { key: 'decode', label: 'Extração', icon: Cpu },
  { key: 'faces', label: 'Detectando rostos', icon: ScanFace },
  { key: 'embeddings', label: 'Embeddings + OCR', icon: Sparkles },
  { key: 'cluster', label: 'Clusterizando', icon: Layers3 },
  { key: 'save', label: 'Salvando', icon: Images },
  { key: 'review', label: 'Revisão', icon: Wand2 },
];

export default function ScannerWorkspace() {
  const { catalogs, setCatalog, refreshCatalogs } = useApp();
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handlePickOri = async () => {
    const res = await api.selectFolder().catch(() => null);
    if (res?.path) setOriPath(res.path);
  };

  const handlePickRef = async () => {
    const res = await api.selectFolder().catch(() => null);
    if (res?.path) setRefPath(res.path);
  };

  const startPolling = useCallback(() => {
    setPolling(true);
    const poll = async () => {
      try {
        const st = await api.getScanStatus();
        setScanStatus(st);
        if (!st.running) {
          setIsScanning(false);
          setIsCompleted(true);
          setPolling(false);
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch { /* ignore */ }
    };
    poll();
    pollRef.current = setInterval(poll, 800);
  }, []);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const handleScan = async () => {
    if (!oriPath) { setError('Selecione a pasta de evento.'); return; }
    const name = newCatalogMode ? newCatalogName.trim() : catalogName;
    if (!name) { setError('Informe o nome do evento.'); return; }
    setError('');
    setStarting(true);
    setIsScanning(true);
    setIsCompleted(false);
    setTimeline(prev => [...prev, { id: `start-${Date.now()}`, kind: 'system', text: `Iniciando scan: ${name}`, timestamp: Date.now() }]);
    try {
      await api.scanFolder(oriPath, refPath, name);
      await setCatalog(name);
      await refreshCatalogs();
      startPolling();
    } catch {
      setError('Erro ao iniciar o scan.');
      setIsScanning(false);
      setStarting(false);
    }
  };

  const progress = scanStatus ? (scanStatus.progress ?? 0) : 0;
  const progressPct = typeof progress === 'number' ? Math.max(0, Math.min(100, progress <= 1 ? progress * 100 : progress)) : 0;

  return (
    <div className={styles.workspace}>
      <div className="toolbar">
        <div className="toolbarTitle">Scanner</div>
        <div className="toolbarSpacer" />
        {isScanning && (
          <button className="btn-secondary" onClick={() => setIsFeedPaused(p => !p)}>
            {isFeedPaused ? <Play size={14} /> : <Pause size={14} />}
            {isFeedPaused ? 'Retomar' : 'Pausar'}
          </button>
        )}
      </div>

      <div className={styles.columns}>
        {/* ── Left: Config ── */}
        <div className={styles.leftPanel}>
          <div>
            <h2>Configuração do Scan</h2>
            <p className={styles.panelSub}>Configure a origem e o destino do escaneamento.</p>
          </div>

          <div className={styles.section}>
            <span className={styles.sectionLabel}>
              <span className="badge badge-blue badge-sm">01</span>
              Evento / Catálogo
            </span>
            <span className={styles.sectionHint}>Escolha um evento existente ou crie um novo.</span>
            {newCatalogMode ? (
              <div className={styles.inputRow}>
                <input className="input-base" placeholder="Novo evento..." value={newCatalogName} onChange={e => setNewCatalogName(e.target.value)} autoFocus />
                <button className={styles.folderBtn} onClick={() => { setNewCatalogMode(false); setNewCatalogName(''); }}><X size={14} /></button>
              </div>
            ) : (
              <div className={styles.inputRow}>
                <select className="select-base" value={catalogName} onChange={e => setCatalogName(e.target.value)} style={{ flex: 1 }}>
                  {catalogs.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <button className={styles.folderBtn} onClick={() => setNewCatalogMode(true)} title="Novo evento"><Plus size={15} /></button>
              </div>
            )}
          </div>

          <div className={styles.section}>
            <span className={styles.sectionLabel}>
              <span className="badge badge-blue badge-sm">02</span>
              Pasta de Evento
            </span>
            <span className={styles.sectionHint}>Fotos do evento que serão escaneadas.</span>
            <div className={styles.inputRow}>
              <input className="input-base" placeholder="C:\\Fotos\\Evento..." value={oriPath} onChange={e => setOriPath(e.target.value)} />
              <button className={styles.folderBtn} onClick={handlePickOri}><FolderOpen size={14} /></button>
            </div>
          </div>

          <div className={styles.section}>
            <span className={styles.sectionLabel}>
              <span className="badge badge-blue badge-sm">03</span>
              Pasta de Referência
            </span>
            <span className={styles.sectionHint}>Fotos nomeadas para reconhecimento facial (opcional).</span>
            <div className={styles.inputRow}>
              <input className="input-base" placeholder="(opcional) Referências..." value={refPath} onChange={e => setRefPath(e.target.value)} />
              <button className={styles.folderBtn} onClick={handlePickRef}><FolderOpen size={14} /></button>
            </div>
          </div>

          {error && <p className="review-msg" style={{ background: 'rgba(239,68,68,0.15)', color: '#fca5a5', borderColor: 'rgba(239,68,68,0.3)' }}>{error}</p>}

          <div className={styles.actions}>
            <button className="btn-primary" onClick={handleScan} disabled={!oriPath || (!newCatalogMode && !catalogName)} style={{ flex: 1, justifyContent: 'center' }}>
              {starting && !scanStatus ? <LoaderCircle size={15} className="spin" /> : <Scan size={15} />}
              {starting ? 'Iniciando...' : 'Iniciar Scan'}
            </button>
          </div>
        </div>

        {/* ── Center: Preview ── */}
        <div className={styles.centerPanel}>
          {isScanning && scanStatus?.recent_faces ? (
            <div className={styles.thumbGrid}>
              {scanStatus.recent_faces.slice(0, 20).map((face, i) => (
                <div key={face.path || i} className={styles.thumbItem} style={{ position: 'relative' }}>
                  <img src={`/api/thumb?path=${encodeURIComponent(face.path)}&size=200`} alt="" loading="lazy" />
                </div>
              ))}
            </div>
          ) : isCompleted ? (
            <div className="empty-state">
              <CheckCircle2 size={48} opacity={0.3} />
              <h3>Scan concluído</h3>
              <p>As fotos foram processadas. Vá para a Revisão para organizar os resultados.</p>
            </div>
          ) : (
            <div className="empty-state">
              <Scan size={48} opacity={0.2} />
              <h3>Scan de Fotos</h3>
              <p>Configure os parâmetros e inicie o escaneamento.</p>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <span className="badge badge-blue"><ScanFace size={12} /> Reconhecimento facial</span>
                <span className="badge badge-blue"><Sparkles size={12} /> OCR</span>
                <span className="badge badge-blue"><UserCheck size={12} /> Qualidade IA</span>
              </div>
            </div>
          )}
        </div>

        {/* ── Right: Status ── */}
        <div className={styles.rightPanel}>
          <div>
            <span className={styles.panelTitle}>Processamento</span>
            {isScanning ? (
              <span className="badge badge-amber badge-sm" style={{ marginLeft: 6 }}>Em andamento</span>
            ) : isCompleted ? (
              <span className="badge badge-green badge-sm" style={{ marginLeft: 6 }}>Concluído</span>
            ) : null}
          </div>

          {isScanning && (
            <>
              <div>
                <div className={styles.progressTrack}>
                  <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
                </div>
                <div className={styles.progressInfo}>
                  <span>{scanStatus?.status_text || 'Processando...'}</span>
                  <span>{progressPct.toFixed(0)}%</span>
                </div>
              </div>

              <div className={styles.pipeline}>
                {PIPELINE.map(step => {
                  const done = ['cluster', 'save', 'review'].includes(step.key)
                    ? isCompleted
                    : progressPct > (PIPELINE.findIndex(s => s.key === step.key) / PIPELINE.length) * 100;
                  const active = !done && progressPct >= ((PIPELINE.findIndex(s => s.key === step.key) - 1) / PIPELINE.length) * 100;
                  return (
                    <div key={step.key} className={`${styles.pipelineStep} ${done ? styles.done : ''} ${active ? styles.active : ''}`}>
                      {done ? <CheckCircle2 size={14} className={styles.pipelineStepIcon} /> : active ? <LoaderCircle size={14} className={`${styles.pipelineStepIcon} spin`} /> : <Circle size={14} className={styles.pipelineStepIcon} />}
                      <step.icon size={13} />
                      <span>{step.label}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {isCompleted && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button className="btn-primary" onClick={() => {}} style={{ justifyContent: 'center' }}>
                <Wand2 size={15} />
                Ir para Revisão
              </button>
              <button className="btn-secondary" onClick={() => { window.location.reload(); }} style={{ justifyContent: 'center' }}>
                <Scan size={15} />
                Novo Scan
              </button>
            </div>
          )}

          <div>
            <span className={styles.panelTitle}>Estatísticas</span>
          </div>
          <div className={styles.statsGrid}>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{scanStatus?.photos_processed ?? 0}</span>
              <span className={styles.statLabel}>Processadas</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{scanStatus?.faces_detected ?? 0}</span>
              <span className={styles.statLabel}>Rostos</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{scanStatus?.errors ?? 0}</span>
              <span className={styles.statLabel}>Erros</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{scanStatus?.speed ?? '—'}</span>
              <span className={styles.statLabel}>Velocidade</span>
            </div>
          </div>

          {timeline.length > 0 && (
            <div>
              <span className={styles.panelTitle}>Logs</span>
              <div className={styles.timeline}>
                {timeline.slice(-30).reverse().map(entry => (
                  <div key={entry.id} className={`${styles.timelineEntry} ${entry.kind === 'warning' ? styles.warning : ''}`}>
                    <span className={styles.timelineTime}>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                    <span>{entry.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
