import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Blocks,
  CheckCircle2,
  Circle,
  Cpu,
  EyeOff,
  FolderSearch,
  Images,
  Layers3,
  LoaderCircle,
  Pause,
  Play,
  ScanFace,
  Sparkles,
  UserCheck,
  Wand2,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ScanRecentFace, ScanStatus } from '../../services/api';
import { getGridHighThumbUrl, getGridThumbUrl } from '../../utils/imageUrls';
import styles from './ScanProcessingCenter.module.css';

export interface ScanTimelineEntry {
  id: string;
  kind: 'system' | 'face' | 'match' | 'cluster' | 'summary' | 'warning';
  text: string;
  timestamp: number;
}

interface ScanProcessingCenterProps {
  currentCatalog: string;
  scanStatus: ScanStatus | null;
  scanMsg: string;
  isScanning: boolean;
  timeline: ScanTimelineEntry[];
  sourcePath?: string | null;
  isFeedPaused: boolean;
  isCompleted: boolean;
  onToggleFeedPaused: () => void;
  onCancel: () => void;
  onClose: () => void;
  onOpenReview: () => void;
  onNewScan: () => void;
  canOpenReview: boolean;
}

interface PipelineStep {
  key: string;
  label: string;
  hint: string;
  icon: typeof FolderSearch;
}

const PRIMARY_PIPELINE_STEPS: PipelineStep[] = [
  { key: 'scan', label: 'Scan de pastas', hint: 'Mapeando lotes e origem', icon: FolderSearch },
  { key: 'decode', label: 'Extração / decode', hint: 'Lendo imagens com segurança', icon: Cpu },
  { key: 'faces', label: 'Detectando rostos', hint: 'Separando rostos principais', icon: ScanFace },
  { key: 'embeddings', label: 'Gerando embeddings + OCR', hint: 'OCR e vetores no mesmo fluxo', icon: Sparkles },
  { key: 'cluster', label: 'Clusterizando', hint: 'Agrupando semelhanças durante o scan', icon: Blocks },
  { key: 'save', label: 'Salvando banco', hint: 'Persistindo ocorrências e relações', icon: Images },
  { key: 'review', label: 'Revisão pronta', hint: 'Fila já preparada para abertura', icon: Wand2 },
];

const SECONDARY_ANALYSES = [
  'Beca',
  'Canudo',
  'Capelo',
  'Faixa',
  'Blur',
  'Quality audit',
];

function normalizeProgress(progress: number | undefined) {
  if (!Number.isFinite(progress)) return 0;
  const value = Number(progress);
  return Math.max(0, Math.min(100, value <= 1 ? value * 100 : value));
}

function formatInteger(value: number | undefined) {
  return new Intl.NumberFormat('pt-BR').format(value ?? 0);
}

function formatEta(seconds: number | undefined) {
  if (!seconds || seconds <= 0) return 'calculando ETA';
  if (seconds < 60) return `${seconds}s restantes`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s restantes`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m restantes`;
}

function formatTimelineTime(timestamp: number) {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function formatCatalogMeta(status: ScanStatus | null, sourcePath?: string | null) {
  const totalFiles = status?.total_files ?? 0;
  const totalLabel = totalFiles > 0 ? `${formatInteger(totalFiles)} fotos` : 'Aguardando lote inicial';
  const sizeLabel = sourcePath ? 'tamanho em análise' : 'origem em preparação';
  return `${totalLabel} - ${sizeLabel}`;
}

function getFaceKind(face: ScanRecentFace) {
  if (!face.name) return 'face';
  if (face.name.toLowerCase().startsWith('pessoa ')) return 'cluster';
  return 'match';
}

function faceLabel(face: ScanRecentFace) {
  const kind = getFaceKind(face);
  if (kind === 'match') return face.name;
  if (kind === 'cluster') return 'Novo cluster';
  return 'Rosto detectado';
}

function faceHint(face: ScanRecentFace) {
  const kind = getFaceKind(face);
  if (kind === 'match') return 'match automático';
  if (kind === 'cluster') return face.name;
  return 'detecção recente';
}

function photoSequenceLabel(path: string) {
  const filename = path.split(/[\\/]/).pop() || '';
  const numberMatch = filename.match(/(\d+)(?=\.[^.]+$)/);
  return numberMatch?.[1] || filename.replace(/\.[^.]+$/, '') || 'foto';
}

function formatAiDeviceLabel(status: ScanStatus | null) {
  const provider = status?.provider || '';
  const device = status?.device || '';

  if (device && device !== 'GPU' && device !== 'CPU') return device;
  if (provider === 'CUDAExecutionProvider') return 'GPU NVIDIA';
  if (provider === 'DmlExecutionProvider') return 'GPU DirectML';
  if (provider === 'CPUExecutionProvider') return 'CPU';
  if (device === 'GPU') return 'GPU';
  return 'CPU';
}

function deriveCurrentStep(status: ScanStatus | null, progressPct: number) {
  const text = (status?.status_text || '').toLowerCase();
  if (!status?.is_scanning && status?.scan_summary) return PRIMARY_PIPELINE_STEPS.length - 1;
  if (text.includes('inicial')) return 0;
  if (text.includes('refer')) return 0;
  if (text.includes('carreg')) return 1;
  if (text.includes('decod')) return 1;
  if (text.includes('processando lote') || text.includes('detect')) return progressPct >= 28 ? 2 : 1;
  if (text.includes('emb') || text.includes('ocr')) return 3;
  if (text.includes('cluster')) return 4;
  if (text.includes('salv')) return 5;
  if (progressPct >= 94) return 6;
  if (progressPct >= 84) return 5;
  if (progressPct >= 68) return 4;
  if (progressPct >= 48) return 3;
  if (progressPct >= 22) return 2;
  return 1;
}

const LiveFaceCard = memo(function LiveFaceCard({
  face,
}: {
  face: ScanRecentFace;
}) {
  const label = faceLabel(face);
  const hint = faceHint(face);
  const thumbUrl = getGridThumbUrl(face.path, 400) ?? '';
  const previewUrl = getGridHighThumbUrl(face.path, 600) ?? '';
  const [src, setSrc] = useState(thumbUrl);
  const [triedPreview, setTriedPreview] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSrc(thumbUrl);
    setTriedPreview(false);
    setLoaded(false);
    setFailed(false);
  }, [thumbUrl, face.path]);

  const handleError = () => {
    if (!triedPreview && src !== previewUrl) {
      setTriedPreview(true);
      setSrc(previewUrl);
      return;
    }
    setFailed(true);
  };

  return (
    <motion.article
      layout
      className={styles.faceCard}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      <div className={styles.faceImageWrap}>
        {!failed ? (
          <img
            className={`${styles.faceImage} ${loaded ? styles.faceImageLoaded : styles.faceImageLoading}`}
            src={src}
            alt={label}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            onLoad={() => setLoaded(true)}
            onError={handleError}
          />
        ) : (
          <div className={styles.faceImageFallback} aria-label={label}>
            <ScanFace size={18} />
          </div>
        )}
      </div>
      <div className={styles.faceMeta}>
        <span className={styles.faceLabel}>{photoSequenceLabel(face.path)}</span>
        <span className={styles.faceHint}>{hint}</span>
      </div>
    </motion.article>
  );
});

export const ScanProcessingCenter = memo(function ScanProcessingCenter({
  currentCatalog,
  scanStatus,
  scanMsg,
  isScanning,
  timeline,
  sourcePath,
  isFeedPaused,
  isCompleted,
  onToggleFeedPaused,
  onCancel,
  onClose,
  onOpenReview,
  onNewScan,
  canOpenReview,
}: ScanProcessingCenterProps) {
  const deferredFaces = useDeferredValue(scanStatus?.recent_faces ?? []);
  const latestTimeline = useMemo(() => timeline.slice(-18), [timeline]);
  const [frozenFaces, setFrozenFaces] = useState<ScanRecentFace[]>([]);
  const [frozenTimeline, setFrozenTimeline] = useState<ScanTimelineEntry[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isFeedPaused) setFrozenFaces(deferredFaces);
  }, [deferredFaces, isFeedPaused]);

  useEffect(() => {
    if (!isFeedPaused) setFrozenTimeline(latestTimeline);
  }, [isFeedPaused, latestTimeline]);

  const visibleFaces = isFeedPaused ? frozenFaces : deferredFaces;
  const visibleTimeline = isFeedPaused ? frozenTimeline : latestTimeline;
  const progressPct = isCompleted ? 100 : normalizeProgress(scanStatus?.progress);
  const gridFaces = visibleFaces.slice(0, 12);
  const currentStep = deriveCurrentStep(scanStatus, progressPct);
  const sourceLabel = sourcePath || scanStatus?.last_folder_scanned || '';
  const processedLabel = `${formatInteger(scanStatus?.total_processadas)} / ${formatInteger(scanStatus?.total_files)}`;
  const headerStatusLabel = isCompleted ? 'Processamento concluído' : (scanMsg || scanStatus?.status_text || 'Processando...');
  const headerStatusHint = isCompleted ? 'Pronto para revisão ou novo scan.' : formatEta(scanStatus?.eta_seconds);
  const pipelineSummary = isCompleted ? 'concluído' : (scanStatus?.scan_summary ? 'revisão pronta' : 'em análise');
  const aiDeviceLabel = formatAiDeviceLabel(scanStatus);
  const computeLabel = isCompleted ? `${aiDeviceLabel} utilizada` : `${aiDeviceLabel} ativa`;

  useEffect(() => {
    if (!logRef.current || isFeedPaused) return;
    logRef.current.scrollTo({
      top: logRef.current.scrollHeight,
      behavior: visibleTimeline.length > 10 ? 'auto' : 'smooth',
    });
  }, [isFeedPaused, visibleTimeline]);

  return (
    <section className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.headerEyebrow}>Central de processamento IA</span>
          <h2 className={styles.catalogTitle}>{currentCatalog || 'Scan em andamento'}</h2>
          <p className={styles.catalogMeta}>{formatCatalogMeta(scanStatus, sourceLabel)}</p>
          {sourceLabel && <p className={styles.sourcePath}>{sourceLabel}</p>}
        </div>

        <div className={styles.headerCenter}>
          <span className={styles.statusLabel}>{headerStatusLabel}</span>
          <div className={styles.progressTrack}>
            <motion.div
              className={styles.progressFill}
              animate={{ width: `${progressPct}%` }}
              transition={{ duration: 0.28, ease: 'easeOut' }}
            />
          </div>
          <div className={styles.progressMeta}>
            <span>{processedLabel} processadas</span>
            <span>{headerStatusHint}</span>
          </div>
        </div>

        <div className={styles.headerActions}>
          <div className={`${styles.computeBadge} ${isCompleted ? styles.computeBadgeDone : ''}`}>
            <Cpu size={14} />
            <span>{computeLabel}</span>
            <strong>{isCompleted ? 'OK' : `${Math.round(progressPct)}%`}</strong>
          </div>

          {isCompleted ? (
            <>
              <button className={styles.actionBtn} onClick={onNewScan}>
                <span>Novo scan</span>
              </button>

              <button className={styles.actionBtnAccent} onClick={onOpenReview} disabled={!canOpenReview}>
                <span>Abrir revisão</span>
              </button>
            </>
          ) : (
            <>
              <button className={styles.actionBtn} onClick={onToggleFeedPaused} title="Pausar apenas o painel visual">
                {isFeedPaused ? <Play size={15} /> : <Pause size={15} />}
                <span>{isFeedPaused ? 'Retomar' : 'Pausar'}</span>
              </button>

              <button className={styles.actionBtnDanger} onClick={onCancel} disabled={!isScanning}>
                <span>Cancelar</span>
              </button>

              <button className={styles.actionBtnAccent} onClick={onOpenReview} disabled={!canOpenReview}>
                <span>Revisão</span>
              </button>
            </>
          )}

          <button className={styles.iconBtn} onClick={onClose} title="Fechar painel">
            <X size={15} />
          </button>
        </div>
      </header>

      <section className={styles.pipelinePanel}>
        <div className={styles.panelHeader}>
          <div>
            <h3>Pipeline IA</h3>
            <p>Etapas ativas do processamento.</p>
          </div>
        </div>

        <div className={styles.pipelineList}>
          {PRIMARY_PIPELINE_STEPS.map((step, index) => {
            const Icon = step.icon;
            const isDone = !isScanning ? index <= currentStep : index < currentStep;
            const isCurrent = isScanning ? index === currentStep : index === currentStep && Boolean(scanStatus?.scan_summary);
            return (
              <div
                key={step.key}
                className={`${styles.pipelineItem} ${isCurrent ? styles.pipelineItemCurrent : ''}`}
              >
                <span className={styles.pipelineIcon}>
                  {isDone ? (
                    <CheckCircle2 size={16} />
                  ) : isCurrent ? (
                    <LoaderCircle size={16} className={styles.spin} />
                  ) : (
                    <Circle size={14} />
                  )}
                </span>
                <div className={styles.pipelineMeta}>
                  <span className={styles.pipelineLabel}>
                    <Icon size={14} />
                    <span>{step.label}</span>
                  </span>
                  <span className={styles.pipelineHint}>{step.hint}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className={styles.secondaryPanel}>
          <div className={styles.secondaryHeader}>
            <span className={styles.secondaryTitle}>Análises complementares</span>
            <span className={styles.secondaryHint}>Rodam em background sem bloquear a Revisão IA</span>
          </div>
          <div className={styles.secondaryList}>
            {SECONDARY_ANALYSES.map((item) => (
              <span key={item} className={styles.secondaryChip}>
                {item}
              </span>
            ))}
          </div>
        </div>

        <div className={styles.pipelineFooter}>
          <StatusChip label={isCompleted ? 'Estado' : 'ETA'} value={isCompleted ? 'concluído' : formatEta(scanStatus?.eta_seconds)} />
          <StatusChip label="Resumo" value={pipelineSummary} />
        </div>

        {scanStatus?.gpu_error && (
          <div className={styles.warningBox}>
            <span className={styles.warningTitle}>Fallback de aceleração</span>
            <span className={styles.warningText}>{scanStatus.gpu_error}</span>
          </div>
        )}
      </section>

      <section className={styles.metricsPanel}>
        <MetricCard icon={Images} label="Processadas" value={formatInteger(scanStatus?.total_processadas)} />
        <MetricCard icon={UserCheck} label="Matches" value={formatInteger(scanStatus?.total_matches)} />
        <MetricCard icon={Layers3} label="Clusters" value={formatInteger(scanStatus?.total_clusters)} />
        <MetricCard icon={EyeOff} label="Ignoradas" value={formatInteger(scanStatus?.skipped_background_faces)} />
      </section>

      <section className={styles.liveGridPanel}>
        <div className={styles.panelHeader}>
          <div>
            <h3>Grid vivo</h3>
            <p>Miniaturas recentes do processamento visual da IA.</p>
          </div>
          <span className={styles.sectionPill}>{gridFaces.length} visíveis</span>
        </div>

        <div className={styles.liveGrid}>
          <AnimatePresence initial={false}>
            {gridFaces.length > 0 ? (
              gridFaces.map((face) => <LiveFaceCard key={`${face.path}-${face.box.join('-')}`} face={face} />)
            ) : (
              <motion.div
                key="placeholder"
                className={styles.gridPlaceholder}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                O feed visual vai aparecer conforme os rostos entrarem no lote.
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>

      <section className={styles.timelinePanel}>
        <div className={styles.panelHeader}>
          <div>
            <h3>Timeline</h3>
            <p>Registro discreto das últimas ações do scanner.</p>
          </div>
          <span className={styles.sectionPill}>{visibleTimeline.length} entradas</span>
        </div>

        <div className={styles.timelineViewport}>
          <div ref={logRef} className={styles.timelineList}>
            {visibleTimeline.length > 0 ? (
              visibleTimeline.map((entry) => (
                <div key={entry.id} className={styles.timelineItem}>
                  <span className={styles.timelineTime}>[{formatTimelineTime(entry.timestamp)}]</span>
                  <span className={`${styles.timelineDot} ${styles[`timelineDot${entry.kind[0].toUpperCase()}${entry.kind.slice(1)}`]}`} />
                  <span className={styles.timelineText}>{entry.text}</span>
                </div>
              ))
            ) : (
              <div className={styles.timelineEmpty}>Os eventos do scanner aparecerão aqui conforme o lote evoluir.</div>
            )}
          </div>
          <div className={styles.timelineFade} />
        </div>
      </section>
    </section>
  );
});

function MetricCard({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className={styles.metricCard}>
      <span className={styles.metricIcon}>
        <Icon size={15} />
      </span>
      <span className={styles.metricLabel}>{label}</span>
      <strong className={styles.metricValue}>{value}</strong>
    </div>
  );
}

function StatusChip({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.statusChip}>
      <span className={styles.statusChipLabel}>{label}</span>
      <strong className={styles.statusChipValue}>{value}</strong>
    </div>
  );
}

