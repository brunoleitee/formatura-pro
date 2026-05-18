import { Component, type ErrorInfo, type ReactNode, useState, useEffect, useCallback, useRef } from 'react';
import { UserCheck, RefreshCw, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../services/api';
import type { AssignClusterResponse, Photo, PhotoContextResponse, GraduationAnalysisStatus, ReviewClusterSummary, RichCluster } from '../services/api';
import { useApp } from '../context/AppContext';
import ReviewSidebar from '../components/review/ReviewSidebar';
import ClusterDetail from '../components/review/ClusterDetail';
import { PhotoViewerModal } from '../components/photos/PhotoViewerModal';
import { isKnownFace } from '../utils/personIdentity';
import styles from './ReviewView.module.css';

const REVIEW_PAGE_SIZE = 30;

function createViewerStub(path: string): Photo {
  const name = path.split(/[\\/]/).pop() || path;
  const ext = name.includes('.') ? (name.split('.').pop() || 'img') : 'img';
  return {
    path,
    name,
    type: ext,
    size: null,
    mtime: null,
    ctime: null,
    faces: [],
    total_faces_in_db: 0,
    discarded: false,
    blur_score: null,
    blur_status: null,
    blur_label: null,
    closed_eyes: false,
  };
}

function getKnownNames(photo: Photo | null | undefined) {
  if (!photo?.faces?.length) return [];
  const names = photo.faces
    .filter(isKnownFace)
    .map((face) => face.aluno_id.trim())
    .filter(Boolean);
  return Array.from(new Set(names));
}

function buildContextBadge(context: PhotoContextResponse | null) {
  if (!context) return null;

  const neighbors = [
    ...(context.previous ? [{ photo: context.previous, label: 'foto anterior' }] : []),
    ...(context.next ? [{ photo: context.next, label: 'foto próxima' }] : []),
    ...(context.neighbors ?? [])
      .filter((photo) => photo.path !== context.current?.path)
      .map((photo) => ({ photo, label: 'contexto' })),
  ];

  for (const item of neighbors) {
    const names = getKnownNames(item.photo);
    if (names.length > 0) {
      return `Possível contexto encontrado: ${names[0]} (${item.label})`;
    }
  }

  return null;
}

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
  const [clusters, setClusters] = useState<ReviewClusterSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [selected, setSelected] = useState<RichCluster | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [totalClusters, setTotalClusters] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [pageOffset, setPageOffset] = useState(0);
  const [reviewReady, setReviewReady] = useState(true);
  const [totalFacesInCatalog, setTotalFacesInCatalog] = useState(0);
  const [graduationStatus, setGraduationStatus] = useState<GraduationAnalysisStatus | null>(null);
  const [isStartingGraduationAnalysis, setIsStartingGraduationAnalysis] = useState(false);
  const [viewerPhoto, setViewerPhoto] = useState<Photo | null>(null);
  const [viewerContext, setViewerContext] = useState<PhotoContextResponse | null>(null);
  const [viewerContextLoading, setViewerContextLoading] = useState(false);
  const [assignmentState, setAssignmentState] = useState<{ clusterId: string; studentName: string; className: string; status: string } | null>(null);
  const [assignmentToast, setAssignmentToast] = useState<string | null>(null);
  const [reviewToast, setReviewToast] = useState<{ message: string; variant: 'success' | 'error' } | null>(null);
const wasGraduationRunningRef = useRef(false);
  const detailRequestRef = useRef(0);
  const clusterCacheRef = useRef<Map<string, { cluster: RichCluster; review_ready: boolean }>>(new Map());

  const loadAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    // Cancelar request anterior se existir
    if (loadAbortRef.current) {
      loadAbortRef.current.abort();
    }
    const controller = new AbortController();
    loadAbortRef.current = controller;

    if (!currentCatalog) return;
    setLoading(true);
    try {
      const data = await api.getReviewClusters(currentCatalog, REVIEW_PAGE_SIZE, 0, controller.signal);
      if (controller.signal.aborted) return;
      const nextClusters = data?.clusters ?? [];
      setClusters(nextClusters);
      setTotalClusters(data?.total ?? nextClusters.length);
      setHasMore(Boolean(data?.has_more));
      setPageOffset(nextClusters.length);
      setReviewReady(Boolean(data?.review_ready ?? true));
      setTotalFacesInCatalog(data?.total_faces_in_catalog ?? 0);
      setSelectedId((prev) => {
        if (nextClusters.length === 0) return null;
        if (prev && nextClusters.some((cluster) => cluster.cluster_id === prev)) return prev;
        return nextClusters[0].cluster_id;
      });
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        setClusters([]);
        setSelectedId(null);
        setSelected(null);
        setTotalClusters(0);
        setHasMore(false);
        setPageOffset(0);
        setReviewReady(false);
        setTotalFacesInCatalog(0);
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [currentCatalog]);

  const loadMore = useCallback(async () => {
    if (!currentCatalog || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const data = await api.getReviewClusters(currentCatalog, REVIEW_PAGE_SIZE, pageOffset);
      const nextClusters = data?.clusters ?? [];
      setClusters((prev) => {
        const existing = new Set(prev.map((cluster) => cluster.cluster_id));
        return [...prev, ...nextClusters.filter((cluster) => !existing.has(cluster.cluster_id))];
      });
      setTotalClusters(data?.total ?? totalClusters);
      setHasMore(Boolean(data?.has_more));
      setPageOffset((prev) => prev + nextClusters.length);
      setReviewReady(Boolean(data?.review_ready ?? true));
      if (data?.total_faces_in_catalog !== undefined) setTotalFacesInCatalog(data.total_faces_in_catalog);
    } finally {
      setLoadingMore(false);
    }
  }, [currentCatalog, hasMore, loadingMore, pageOffset, totalClusters]);

  const loadClusterDetail = useCallback(async (clusterId: string) => {
    if (!currentCatalog || !clusterId) return;

    const cached = clusterCacheRef.current.get(clusterId);
    if (cached) {
      setSelected(cached.cluster);
      setReviewReady(Boolean(cached.review_ready));
      return;
    }

    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setSelected((current) => (current?.cluster_id === clusterId ? current : null));
    setLoadingDetail(true);
    try {
      const data = await api.getReviewClusterDetail(currentCatalog, clusterId);
      if (detailRequestRef.current !== requestId) return;
      if (data?.cluster) {
        clusterCacheRef.current.set(clusterId, { cluster: data.cluster, review_ready: data.review_ready ?? true });
      }
      setSelected(data?.cluster ?? null);
      setReviewReady(Boolean(data?.review_ready ?? true));
    } catch {
      if (detailRequestRef.current !== requestId) return;
      setSelected(null);
    } finally {
      if (detailRequestRef.current === requestId) {
        setLoadingDetail(false);
      }
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
    setSelectedId(null);
    setAssignmentState(null);
    detailRequestRef.current += 1;
    load();
    refreshGraduationStatus();
    return () => {
      if (loadAbortRef.current) {
        loadAbortRef.current.abort();
      }
    };
  }, [load, refreshGraduationStatus]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    loadClusterDetail(selectedId);
  }, [loadClusterDetail, selectedId]);

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

  useEffect(() => {
    return () => {
      setAssignmentToast(null);
      setReviewToast(null);
    };
  }, []);

  const showReviewToast = useCallback((message: string, variant: 'success' | 'error' = 'success') => {
    setReviewToast({ message, variant });
    window.setTimeout(() => setReviewToast(null), 1800);
  }, []);

  const handleAssigned = useCallback((result: AssignClusterResponse) => {
    const clusterId = result.cluster_id;
    const studentName = result.student_name ?? result.nome_formando ?? result.aluno_id ?? 'Identificado';
    const className = result.class_name ?? 'Sem turma';
    setAssignmentToast(`Formando vinculado com sucesso: ${studentName} · ${className}`);
    window.setTimeout(() => setAssignmentToast(null), 1800);
    setAssignmentState({ clusterId, studentName, className, status: result.status || 'identified' });
    const assignedIndex = clusters.findIndex((cluster) => cluster.cluster_id === clusterId);
    const nextSelectedId = assignedIndex >= 0
      ? clusters[assignedIndex + 1]?.cluster_id ?? clusters[assignedIndex - 1]?.cluster_id ?? null
      : null;

    setClusters((prev) => prev.filter((cluster) => cluster.cluster_id !== clusterId));
    setTotalClusters((value) => (assignedIndex >= 0 ? Math.max(0, value - 1) : value));
    setSelectedId((currentId) => (currentId === clusterId ? nextSelectedId : currentId));
    setSelected((current) => (current?.cluster_id === clusterId ? null : current));
    window.setTimeout(() => setAssignmentState(null), 1800);
  }, [clusters]);

  const handleSkip = useCallback(async () => {
    if (!currentCatalog || !selectedId) return;
    const currentClusterId = selectedId;
    const currentIndex = clusters.findIndex((cluster) => cluster.cluster_id === currentClusterId);
    if (currentIndex < 0) {
      setSelectedId(null);
      setSelected(null);
      return;
    }

    const nextSelectedId = clusters[currentIndex + 1]?.cluster_id ?? clusters[currentIndex - 1]?.cluster_id ?? null;
    const ignoredRowids = selected?.faces
      ?.map((face) => face.rowid)
      .filter((rowid): rowid is number => Number.isFinite(rowid)) ?? [];
    const previousClusters = clusters;
    const previousTotal = totalClusters;
    const previousSelected = selected;
    const previousSelectedId = selectedId;
    const previousAssignmentState = assignmentState;

    detailRequestRef.current += 1;
    setLoadingDetail(false);
    setClusters((prev) => prev.filter((cluster) => cluster.cluster_id !== currentClusterId));
    setTotalClusters((value) => Math.max(0, value - 1));
    setSelected((current) => (current?.cluster_id === currentClusterId ? null : current));
    setSelectedId(nextSelectedId);
    setAssignmentState(null);

    try {
      await api.ignoreCluster(currentCatalog, currentClusterId, ignoredRowids);
      showReviewToast('Grupo ignorado com sucesso');
    } catch (error) {
      console.error('[ignoreCluster] erro:', error);
      detailRequestRef.current += 1;
      setClusters(previousClusters);
      setTotalClusters(previousTotal);
      setSelected(previousSelected);
      setSelectedId(previousSelectedId);
      setAssignmentState(previousAssignmentState);
      setLoadingDetail(false);
      showReviewToast('Não foi possível ignorar o grupo. Tente novamente.', 'error');
    }
  }, [assignmentState, clusters, currentCatalog, selected, selectedId, showReviewToast, totalClusters]);

  const handleClusterUpdate = useCallback((next: RichCluster) => {
    setClusters((prev) => prev.map((cluster) => (
      cluster.cluster_id === next.cluster_id
        ? {
            ...cluster,
            cluster_number: next.cluster_number,
            face_count: next.face_count,
            photo_count: next.photo_count,
            total_photos: next.total_photos,
            cohesion_score: next.cohesion_score,
            cohesion: next.cohesion,
            priority_score: next.priority_score,
            graduation_tags: next.graduation_tags,
            has_gown: next.has_gown,
            has_diploma: next.has_diploma,
            has_sash: next.has_sash,
            has_cap: next.has_cap,
            gown_confidence: next.gown_confidence,
            diploma_confidence: next.diploma_confidence,
            sash_confidence: next.sash_confidence,
            cap_confidence: next.cap_confidence,
            manual_graduation_tags: next.manual_graduation_tags,
            debug_graduation_source: next.debug_graduation_source,
            preview_image: next.preview_image,
            representative: next.representative,
          }
        : cluster
    )));
    setSelected((prev) => (prev && prev.cluster_id === next.cluster_id ? next : prev));
  }, []);

  const handleStartGraduationAnalysis = useCallback(async () => {
    if (!currentCatalog || graduationStatus?.is_running || isStartingGraduationAnalysis) return;
    setIsStartingGraduationAnalysis(true);
    try {
      // Gerar embeddings antes da análise de formatura
      try {
        await api.generateAllEmbeddings(currentCatalog);
      } catch { /* continua mesmo se falhar */ }
      await api.startGraduationAnalysis(currentCatalog);
      await refreshGraduationStatus();
    } finally {
      setIsStartingGraduationAnalysis(false);
    }
  }, [currentCatalog, graduationStatus?.is_running, isStartingGraduationAnalysis, refreshGraduationStatus]);

  const openViewerForPath = useCallback((path: string) => {
    setViewerPhoto(createViewerStub(path));
    setViewerContext(null);
    setViewerContextLoading(true);
  }, []);

  useEffect(() => {
    if (!viewerPhoto?.path || !currentCatalog) {
      if (!viewerPhoto) {
        setViewerContext(null);
        setViewerContextLoading(false);
      }
      return;
    }

    let cancelled = false;

    const loadContext = async () => {
      try {
        const context = await api.getPhotoContext(viewerPhoto.path, currentCatalog);
        if (cancelled) return;
        setViewerContext(context);
        setViewerPhoto(context.current ?? createViewerStub(viewerPhoto.path));
      } catch {
        if (cancelled) return;
        const fallback = createViewerStub(viewerPhoto.path);
        setViewerContext({
          current: fallback,
          previous: null,
          next: null,
          neighbors: [fallback],
          index: 0,
          total: 1,
          catalog: currentCatalog,
        });
        setViewerPhoto(fallback);
      } finally {
        if (!cancelled) setViewerContextLoading(false);
      }
    };

    void loadContext();

    return () => {
      cancelled = true;
    };
  }, [currentCatalog, viewerPhoto?.path]);

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
        loadingMore={loadingMore}
        selectedId={selectedId}
        total={totalClusters}
        hasMore={hasMore}
        reviewReady={reviewReady}
        graduationAnalysisRan={Boolean(graduationStatus?.result || graduationStatus?.finished_at)}
        onSelect={setSelectedId}
        onRefresh={load}
        onLoadMore={loadMore}
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
            onOpenPhoto={openViewerForPath}
            assignmentState={assignmentState}
          />
        ) : loadingDetail && selectedId ? (
          <WelcomeState
            key="detail-loading"
            count={clusters.length}
            loading
            loadingMessage="Abrindo grupo..."
            reviewReady={reviewReady}
            onRefresh={load}
          />
        ) : (
          <WelcomeState
            key="welcome"
            count={clusters.length}
            loading={loading}
            loadingMessage="Carregando grupos salvos..."
            reviewReady={reviewReady}
            totalFacesInCatalog={totalFacesInCatalog}
            onRefresh={load}
          />
        )}
      </div>

      {viewerPhoto && (
        <PhotoViewerModal
          photo={viewerPhoto}
          allPhotos={viewerContext?.neighbors?.length ? viewerContext.neighbors : [viewerPhoto]}
          contextPhotos={viewerContext?.neighbors?.length ? viewerContext.neighbors : [viewerPhoto]}
          contextBadge={buildContextBadge(viewerContext)}
          contextLoading={viewerContextLoading}
          onClose={() => {
            setViewerPhoto(null);
            setViewerContext(null);
            setViewerContextLoading(false);
          }}
          onNavigate={setViewerPhoto}
        />
      )}

      {assignmentToast && (
        <div className={styles.assignmentToast}>{assignmentToast}</div>
      )}

      {reviewToast && (
        <div className={`${styles.assignmentToast} ${reviewToast.variant === 'error' ? styles.assignmentToastError : ''}`}>
          {reviewToast.message}
        </div>
      )}
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
  if (isStarting && !isRunning) {
    compactStatus = 'Gerando embeddings das fotos...';
  } else if (isRunning) {
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
        {(isRunning || isStarting) && (
          <span className={styles.analysisCompactBar}>
            <span
              className={`${styles.analysisCompactBarFill} ${isStarting && !isRunning ? styles.analysisCompactBarIndeterminate : ''}`}
              style={isRunning ? { width: `${progress}%` } : undefined}
            />
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
  reviewReady = true,
  totalFacesInCatalog = 0,
  loadingMessage = 'Carregando grupos salvos...',
  onRefresh,
}: {
  count: number;
  loading: boolean;
  reviewReady?: boolean;
  totalFacesInCatalog?: number;
  loadingMessage?: string;
  onRefresh: () => void;
}) {
  const hasNoFaces = totalFacesInCatalog === 0 && count === 0;
  const titleLabel = loading
    ? loadingMessage
    : hasNoFaces
    ? 'Nenhum rosto encontrado'
    : count === 0
    ? (reviewReady ? 'Tudo identificado!' : 'Ainda preparando a revisão')
    : 'Revisão IA';
  const subtitleLabel = loading
    ? 'A primeira página está sendo carregada a partir dos clusters já salvos no catálogo.'
    : hasNoFaces
    ? 'O Scanner processou as fotos, mas nenhum rosto foi detectado nelas.'
    : count === 0
    ? (reviewReady
      ? 'Nenhuma face desconhecida pendente neste evento.'
      : 'Os dados da revisão ainda estão sendo preparados em segundo plano.')
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
          disabled={loading}
        >
          <RefreshCw size={14} />
          <span>Recarregar</span>
        </button>
      </div>
    </div>
  );
}
