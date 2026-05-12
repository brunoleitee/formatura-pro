import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Blocks,
  CheckCircle2,
  Circle,
  Cpu,
  FolderSearch,
  LoaderCircle,
  Pause,
  Play,
  ScanFace,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { api } from '../../services/api';
import type { ScanRecentFace, ScanStatus } from '../../services/api';
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
  onToggleFeedPaused: () => void;
  onCancel: () => void;
  onClose: () => void;
  onOpenReview: () => void;
  canOpenReview: boolean;
}

interface PipelineStep {
  key: string;
  label: string;
  hint: string;
  icon: typeof FolderSearch;
}

const PIPELINE_STEPS: PipelineStep[] = [
  { key: 'scan', label: 'Scan de pastas', hint: 'Mapeando lotes e origem', icon: FolderSearch },
  { key: 'decode', label: 'Extração / decode', hint: 'Lendo imagens com segurança', icon: Cpu },
  { key: 'faces', label: 'Detectando rostos', hint: 'Separando rostos principais', icon: ScanFace },
  { key: 'embeddings', label: 'Embeddings / OCR', hint: 'Transformando sinais em vetores', icon: Sparkles },
  { key: 'cluster', label: 'Clusterização', hint: 'Agrupando semelhanças', icon: Blocks },
  { key: 'review', label: 'Sugestões IA', hint: 'Preparando revisão humana', icon: Wand2 },
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
  return `${totalLabel} • ${sizeLabel}`;
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

function deriveCurrentStep(status: ScanStatus | null, progressPct: number) {
  const text = (status?.status_text || '').toLowerCase();
  if (!status?.is_scanning && status?.scan_summary) return PIPELINE_STEPS.length - 1;
  if (text.includes('inicial')) return 0;
  if (text.includes('refer')) return 0;
  if (text.includes('decod')) return 1;
  if (text.includes('infer') || text.includes('processando lote')) return progressPct >= 62 ? 3 : 2;
  if (progressPct >= 92) return 5;
  if (progressPct >= 78) return 4;
  if (progressPct >= 54) return 3;
  if (progressPct >= 16) return 2;
  return 1;
}

const LiveFaceCard = memo(function LiveFaceCard({
  face,
  active = false,
}: {
  face: ScanRecentFace;
  active?: boolean;
}) {
  const [x1, y1, x2, y2] = face.box;
  const label = faceLabel(face);
  const hint = faceHint(face);

  return (
    <motion.article
      layout
      className={`${styles.faceCard} ${active ? styles.faceCardActive : ''}`}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
    >
      <div className={styles.faceImageWrap}>
        <img
          className={styles.faceImage}
          src={api.faceThumbUrl(face.path, x1, y1, x2, y2, active ? 220 : 180, 0.25, 72)}
          alt={label}
          loading="lazy"
        />
      </div>
      <div className={styles.faceMeta}>
        <span className={styles.faceLabel}>{label}</span>
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
  onToggleFeedPaused,
  onCancel,
  onClose,
  onOpenReview,
  canOpenReview,
}: ScanProcessingCenterProps) {
  const deferredFaces = useDeferredValue(scanStatus?.recent_faces ?? []);
  const latestTimeline = useMemo(() => timeline.slice(-36), [timeline]);
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
  const progressPct = normalizeProgress(scanStatus?.progress);
  const currentFace = visibleFaces[0] ?? null;
  const gridFaces = visibleFaces.slice(1, 11);
  const currentStep = deriveCurrentStep(scanStatus, progressPct);
  const sourceLabel = sourcePath || scanStatus?.last_folder_scanned || '';

  useEffect(() => {
    if (!logRef.current || isFeedPaused) return;
    logRef.current.scrollTo({
      top: logRef.current.scrollHeight,
      behavior: visibleTimeline.length > 12 ? 'auto' : 'smooth',
    });
  }, [isFeedPaused, visibleTimeline]);

  return (
    <section className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerBlock}>
          <span className={styles.headerEyebrow}>Central de processamento IA</span>
          <h2 className={styles.catalogTitle}>{currentCatalog || 'Scan em andamento'}</h2>
          <p className={styles.catalogMeta}>{formatCatalogMeta(scanStatus, sourceLabel)}</p>
          {sourceLabel && <p className={styles.sourcePath}>{sourceLabel}</p>}
        </div>

        <div className={styles.headerStatus}>
          <span className={styles.statusLabel}>{scanMsg || scanStatus?.status_text || 'Processando...'}</span>
          <span className={styles.statusHint}>{formatEta(scanStatus?.eta_seconds)}</span>
        </div>

        <div className={styles.headerActions}>
          <div className={styles.computeBadge}>
            <Cpu size={14} />
            <span>{scanStatus?.device || 'CPU'} ativa</span>
            <strong>{Math.round(progressPct)}%</strong>
          </div>

          <button className={styles.actionBtn} onClick={onToggleFeedPaused} title="Pausar apenas o painel visual">
            {isFeedPaused ? <Play size={15} /> : <Pause size={15} />}
            <span>{isFeedPaused ? 'Retomar painel' : 'Pausar painel'}</span>
          </button>

          <button className={styles.actionBtnDanger} onClick={onCancel} disabled={!isScanning}>
            <span>Cancelar</span>
          </button>

          <button className={styles.actionBtnAccent} onClick={onOpenReview} disabled={!canOpenReview}>
            <span>Abrir revisão</span>
          </button>

          <button className={styles.iconBtn} onClick={onClose} title="Fechar painel">
            <X size={15} />
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.mainPane}>
          <motion.section
            className={styles.hero}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: 'easeOut' }}
          >
            {currentFace ? (
              <>
                <div
                  className={styles.heroBackdrop}
                  style={{ backgroundImage: `url(${api.thumbUrl(currentFace.path, 1200, 74)})` }}
                />
                <div className={styles.heroOverlay} />
                <div className={styles.heroContent}>
                  <div className={styles.heroText}>
                    <span className={styles.heroKicker}>Lote vivo</span>
                    <h3>{faceLabel(currentFace)}</h3>
                    <p>{scanStatus?.status_text || 'A IA está processando as imagens atuais do evento.'}</p>
                  </div>

                  <LiveFaceCard face={currentFace} active />
                </div>
              </>
            ) : (
              <div className={styles.heroEmpty}>
                <LoaderCircle size={20} className={styles.spin} />
                <span>Preparando os primeiros rostos do lote atual...</span>
              </div>
            )}

            <div className={styles.metrics}>
              <MetricCard label="Processadas" value={formatInteger(scanStatus?.total_processadas)} />
              <MetricCard label="Matches" value={formatInteger(scanStatus?.total_matches)} />
              <MetricCard label="Clusters" value={formatInteger(scanStatus?.total_clusters)} />
              <MetricCard label="Ignoradas BG" value={formatInteger(scanStatus?.skipped_background_faces)} />
            </div>
          </motion.section>

          <section className={styles.liveGridPanel}>
            <div className={styles.sectionHeader}>
              <div>
                <h3>Grid vivo de processamento</h3>
                <p>Prévias recentes do que a IA está detectando agora.</p>
              </div>
              <span className={styles.sectionPill}>{visibleFaces.length} eventos recentes</span>
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
        </div>

        <aside className={styles.sidePane}>
          <section className={styles.pipelinePanel}>
            <div className={styles.sectionHeader}>
              <div>
                <h3>Pipeline IA</h3>
                <p>Etapas visuais do processamento atual.</p>
              </div>
            </div>

            <div className={styles.pipelineList}>
              {PIPELINE_STEPS.map((step, index) => {
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
          </section>

          <section className={styles.devicePanel}>
            <div className={styles.sectionHeader}>
              <div>
                <h3>Motor ativo</h3>
                <p>Leitura do estado atual do scanner.</p>
              </div>
            </div>

            <div className={styles.deviceStats}>
              <StatusChip label="Dispositivo" value={scanStatus?.device || 'CPU'} />
              <StatusChip label="Progresso" value={`${Math.round(progressPct)}%`} />
              <StatusChip label="ETA" value={formatEta(scanStatus?.eta_seconds)} />
              <StatusChip label="Resumo" value={scanStatus?.scan_summary ? 'revisão pronta' : 'em análise'} />
            </div>

            {scanStatus?.gpu_error && (
              <div className={styles.warningBox}>
                <span className={styles.warningTitle}>Fallback de aceleração</span>
                <span className={styles.warningText}>{scanStatus.gpu_error}</span>
              </div>
            )}
          </section>
        </aside>
      </div>

      <section className={styles.timelinePanel}>
        <div className={styles.sectionHeader}>
          <div>
            <h3>Timeline do processamento</h3>
            <p>Log visual do que já passou pela central.</p>
          </div>
          <span className={styles.sectionPill}>{visibleTimeline.length} entradas</span>
        </div>

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
      </section>
    </section>
  );
});

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metricCard}>
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
