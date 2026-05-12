import { Component, type ErrorInfo, type ReactNode, useState, useEffect, useCallback, useRef } from 'react';
import { UserCheck, RefreshCw, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../services/api';
import type { GraduationAnalysisStatus, RichCluster } from '../services/api';
import { useApp } from '../context/AppContext';
import ReviewSidebar from '../components/review/ReviewSidebar';
import ClusterDetail from '../components/review/ClusterDetail';
import styles from './ReviewView.module.css';

class ReviewViewBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ReviewViewBoundary] render crash:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
<div className={`${styles.root} ${styles.reviewView}`}>
          <div className={styles.main}>
            <div className={styles.noCatalog}>
              <UserCheck size={40} strokeWidth={1.5} style={{ opacity: 0.25 }} />
              <p>Reabra a Revisão IA ou atualize a tela para tentar novamente.</p>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function ReviewView() {
  return (
    <ReviewViewBoundary>
      <ReviewViewContent />
    </ReviewViewBoundary>
  );
}

function ReviewViewContent() {
  const { currentCatalog } = useApp();
  const [clusters, setClusters] = useState<RichCluster[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<RichCluster | null>(null);
  const [graduationStatus, setGraduationStatus] = useState<GraduationAnalysisStatus | null>(null);
  const [isStartingGraduationAnalysis, setIsStartingGraduationAnalysis] = useState(false);
  const wasGraduationRunningRef = useRef(false);

  const load = useCallback(async () => {
    if (!currentCatalog) return;
    setLoading(true);
    try {
      const data = await api.getUnknownClustersV2(currentCatalog);
      setClusters(data?.clusters ?? []);
    } catch {
      setClusters([]);
    } finally {
      setLoading(false);
    }
  }, [currentCatalog]);

  const refreshGraduationStatus = useCallback(async () => {
    if (!currentCatalog) {
      setGraduationStatus(null);
      return;
    }
    try {
      const status = await api.getGraduationAnalysisStatus(currentCatalog);
      setGraduationStatus(status);
    } catch {
      setGraduationStatus(null);
    }
  }, [currentCatalog]);

  useEffect(() => {
    setSelected(null);
    load();
    refreshGraduationStatus();
  }, [load, refreshGraduationStatus]);

  useEffect(() => {
    if (!currentCatalog || !graduationStatus?.is_running) return;
    const timer = window.setInterval(() => {
      refreshGraduationStatus();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [currentCatalog, graduationStatus?.is_running, refreshGraduationStatus]);

  useEffect(() => {
    const wasRunning = wasGraduationRunningRef.current;
    const isRunning = Boolean(graduationStatus?.is_running);
    if (
      wasRunning &&
      !isRunning &&
      graduationStatus?.result &&
      graduationStatus.catalog === currentCatalog
    ) {
      load();
    }
    wasGraduationRunningRef.current = isRunning;
  }, [currentCatalog, graduationStatus, load]);

  const handleAssigned = useCallback((clusterId: string) => {
    setClusters(prev => {
      const next = prev.filter(c => c.cluster_id !== clusterId);
      // Auto-avança para o próximo cluster
      const idx = prev.findIndex(c => c.cluster_id === clusterId);
      setSelected(next[idx] ?? next[idx - 1] ?? null);
      return next;
    });
  }, []);

  const handleSkip = useCallback(() => {
    if (!selected) return;
    const idx = clusters.findIndex(c => c.cluster_id === selected.cluster_id);
    setSelected(clusters[idx + 1] ?? clusters[idx - 1] ?? null);
  }, [selected, clusters]);

  const handleClusterUpdate = useCallback((next: RichCluster) => {
    setClusters(prev => prev.map(c => (c.cluster_id === next.cluster_id ? next : c)));
    setSelected(prev => (prev && prev.cluster_id === next.cluster_id ? next : prev));
  }, []);

  const handleStartGraduationAnalysis = useCallback(async () => {
    if (!currentCatalog || graduationStatus?.is_running || isStartingGraduationAnalysis) return;
    setIsStartingGraduationAnalysis(true);
    try {
      await api.startGraduationAnalysis(currentCatalog);
      await refreshGraduationStatus();
    } finally {
      setIsStartingGraduationAnalysis(false);
    }
  }, [currentCatalog, graduationStatus?.is_running, isStartingGraduationAnalysis, refreshGraduationStatus]);

  if (!currentCatalog) {
    return (
<div className={`${styles.root} ${styles.reviewView}`}>
        <div className={styles.noCatalog}>
          <UserCheck size={40} strokeWidth={1.5} style={{ opacity: 0.25 }} />
          <p>Selecione um evento para começar a revisão.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.root} ${styles.reviewView}`}>
      {/* Sidebar esquerda de clusters */}
      <ReviewSidebar
        clusters={clusters}
        loading={loading}
        selectedId={selected?.cluster_id ?? null}
        graduationAnalysisRan={Boolean(graduationStatus?.result || graduationStatus?.finished_at)}
        onSelect={setSelected}
        onRefresh={load}
      />

      {/* Área principal */}
      <div className={`${styles.main}`}>
        <GraduationAnalysisPanel
          status={graduationStatus}
          isStarting={isStartingGraduationAnalysis}
          onStart={handleStartGraduationAnalysis}
        />
        {selected ? (
          <ClusterDetail
            key={selected.cluster_id}
            cluster={selected}
            catalog={currentCatalog}
            onAssigned={handleAssigned}
            onSkip={handleSkip}
            onClusterUpdate={handleClusterUpdate}
          />
        ) : (
          <WelcomeState
            key="welcome"
            count={clusters.length}
            loading={loading}
            onRefresh={load}
          />
        )}
      </div>
    </div>
  );
}

function GraduationAnalysisPanel({
  status,
  isStarting,
  onStart,
}: {
  status: GraduationAnalysisStatus | null;
  isStarting: boolean;
  onStart: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isRunning = Boolean(status?.is_running);
  const progress = Math.max(0, Math.min(100, (status?.progress ?? 0) * 100));
  const hasResult = Boolean(status?.result);
  const buttonLabel = isRunning || isStarting ? 'Analisando...' : (hasResult ? 'Reanalisar' : 'Analisar');

  // Status compacto resumido: mostra contagem quando há resultado, ou progresso, ou pronto pra rodar
  let compactStatus: string;
  if (isRunning) {
    compactStatus = `Analisando ${status?.processed ?? 0}/${status?.total ?? 0} (${Math.round(progress)}%)`;
  } else if (status?.error) {
    compactStatus = status.error;
  } else if (status?.result) {
    const n = status.result.processed_files;
    compactStatus = `Itens analisados: ${n} foto${n !== 1 ? 's' : ''}`;
  } else {
    compactStatus = 'Itens de formatura não analisados';
  }

  return (
    <div className={`${styles.analysisPanel} ${open ? styles.analysisPanelOpen : ''}`}>
      <div className={styles.analysisCompact}>
        <span className={styles.analysisEyebrow}>
          <Sparkles size={11} />
          <span>{compactStatus}</span>
        </span>
        {isRunning && (
          <span className={styles.analysisCompactBar}>
            <span className={styles.analysisCompactBarFill} style={{ width: `${progress}%` }} />
          </span>
        )}
        <button
          type="button"
          className={styles.analysisButton}
          onClick={onStart}
          disabled={isRunning || isStarting}
        >
          <RefreshCw
            size={11}
            className={`${styles.spin} ${isRunning || isStarting ? styles.inlineVisible : styles.inlineHidden}`}
          />
          <span>{buttonLabel}</span>
        </button>
        <button
          type="button"
          className={styles.analysisToggle}
          onClick={() => setOpen(v => !v)}
          title={open ? 'Recolher' : 'Detalhes'}
        >
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>

      {open && (
        <div className={styles.analysisDetails}>
          <p className={styles.analysisStatus}>
            <span>{status?.status_text || 'Pronto para rodar a análise visual em segundo plano.'}</span>
          </p>
          {(isRunning || hasResult) && (
            <div className={styles.analysisProgressWrap}>
              <div className={styles.analysisProgressMeta}>
                <span>{status?.processed ?? 0} / {status?.total ?? 0} fotos</span>
                <span>{Math.round(progress)}%</span>
              </div>
              <div className={styles.analysisProgressTrack}>
                <div className={styles.analysisProgressFill} style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
          {!isRunning && status?.result && (
            <div className={styles.analysisResult}>
              <span>
                {status.result.processed_files} foto{status.result.processed_files !== 1 ? 's' : ''} analisada{status.result.processed_files !== 1 ? 's' : ''}
                {' · '}
                {status.result.updated_faces} registro{status.result.updated_faces !== 1 ? 's' : ''} atualizado{status.result.updated_faces !== 1 ? 's' : ''}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WelcomeState({
  count,
  loading,
  onRefresh,
}: {
  count: number;
  loading: boolean;
  onRefresh: () => void;
}) {
  const titleLabel = loading ? 'Calculando agrupamentos...' : count === 0 ? 'Tudo identificado!' : 'Revisão IA';
  const subtitleLabel = loading
    ? 'A IA está analisando as faces similares...'
    : count === 0
    ? 'Nenhuma face desconhecida pendente neste evento.'
    : `${count} grupo${count !== 1 ? 's' : ''} aguardando identificação. Selecione um grupo na barra lateral para começar.`;

  return (
    <div className={styles.welcome}>
      <div className={styles.welcomeInner}>
        <div className={styles.welcomeOrb}>
          {loading ? (
            <RefreshCw size={32} strokeWidth={1.5} className={styles.spin} />
          ) : (
            <UserCheck size={32} strokeWidth={1.5} />
          )}
        </div>

        <h2 className={styles.welcomeTitle}>
          <span>{titleLabel}</span>
        </h2>

        <p className={styles.welcomeSubtitle}>
          <span>{subtitleLabel}</span>
        </p>

        <div className={`${styles.welcomeHint} ${!loading && count > 0 ? styles.blockVisible : styles.blockHidden}`}>
          <span>← Selecione um grupo para revisar</span>
        </div>

        <button
          className={`${styles.welcomeRefresh} ${!loading && count === 0 ? styles.inlineFlexVisible : styles.inlineFlexHidden}`}
          onClick={onRefresh}
          disabled={loading || count > 0}
        >
          <RefreshCw size={14} />
          <span>Recarregar</span>
        </button>
      </div>
    </div>
  );
}
