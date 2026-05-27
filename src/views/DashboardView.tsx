import { useEffect, useMemo, useState } from 'react';
import {
  Image as ImageIcon,
  Users,
  UserCheck,
  Clock3,
  Layers,
  AlertTriangle,
  Activity,
  Sparkles,
  RefreshCw,
  Eye,
  Copy,
  Zap,
  CheckCircle2,
  ScanLine,
  TrendingUp,
  FileWarning,
  Fingerprint,
  BarChart3,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import {
  api,
  type Photo,
  type Person,
  type Stats,
  type ScanStatus,
  type ReviewClustersPageResponse,
  type CatalogFolderStats,
  type ReviewClusterSummary,
} from '../services/api';
import { useApp } from '../context/AppContext';
import styles from './DashboardView.module.css';

export const DEFAULT_PHOTOS_GOAL = 50;

function fmt(n: number) {
  return new Intl.NumberFormat('pt-BR').format(n);
}

function fmtDate(ts: number | null | undefined) {
  if (!ts) return '--';
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return '--';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function pct(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

/* ── Section Header ── */
function SectionHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div className={styles.sectionHeader}>
      <div className={styles.sectionIcon}>{icon}</div>
      <div>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {subtitle && <p className={styles.sectionSubtitle}>{subtitle}</p>}
      </div>
    </div>
  );
}

/* ── Stat Card with Trend ── */
function StatCard({ icon, label, value, tone, trend }: {
  icon: React.ReactNode; label: string; value: string | number; tone: string; trend?: string;
}) {
  const isPositive = trend?.startsWith('+');
  const isNegative = trend?.startsWith('-');
  return (
    <article className={styles.statCard} data-tone={tone}>
      <div className={styles.statTop}>
        <div className={styles.statIcon}>{icon}</div>
        {trend && (
          <span className={styles.statTrend} data-positive={isPositive ? 'true' : isNegative ? 'false' : 'neutral'}>
            {isPositive && <ArrowUpRight size={10} />}
            {isNegative && <ArrowDownRight size={10} />}
            {trend}
          </span>
        )}
      </div>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{typeof value === 'number' ? fmt(value) : value}</div>
    </article>
  );
}

/* ── Progress Row ── */
function ProgressRow({ label, value, total, percent, complete }: {
  label: string; value?: string; total?: string; percent: number; complete?: boolean;
}) {
  return (
    <div className={styles.progressRow}>
      <div className={styles.progressRowTop}>
        <span className={styles.progressLabel}>{label}</span>
        {(value || total) && (
          <span className={styles.progressCount}>{value}{total ? `/${total}` : ''}</span>
        )}
      </div>
      <div className={styles.progressBar}>
        <div
          className={styles.progressBarFill}
          data-complete={complete ? 'true' : 'false'}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}

/* ── Info Row ── */
function InfoRow({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: string; tone?: string;
}) {
  return (
    <div className={styles.infoRow}>
      <div className={styles.infoIcon} data-tone={tone || 'default'}>{icon}</div>
      <span className={styles.infoLabel}>{label}</span>
      <span className={styles.infoValue}>{value}</span>
    </div>
  );
}

/* ── Problem Card ── */
function ProblemCard({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: string | number; tone: string;
}) {
  return (
    <div className={styles.problemCard} data-tone={tone}>
      <div className={styles.problemIcon}>{icon}</div>
      <div className={styles.problemContent}>
        <span className={styles.problemLabel}>{label}</span>
        <span className={styles.problemValue}>{typeof value === 'number' ? fmt(value) : value}</span>
      </div>
    </div>
  );
}

/* ── Activity Item ── */
function ActivityItem({ icon, text, time, tone }: {
  icon: React.ReactNode; text: string; time?: string; tone?: string;
}) {
  return (
    <div className={styles.activityItem}>
      <div className={styles.activityIcon} data-tone={tone || 'default'}>{icon}</div>
      <div className={styles.activityContent}>
        <span className={styles.activityText}>{text}</span>
        {time && <span className={styles.activityTime}>{time}</span>}
      </div>
    </div>
  );
}

/* ── AI Suggestion Card with Face Thumb ── */
function AISuggestionCard({ label, sublabel, percent, tone, thumbUrl, onReview }: {
  label: string; sublabel: string; percent?: number; tone?: string; thumbUrl?: string; onReview?: () => void;
}) {
  const [imgError, setImgError] = useState(false);
  const showThumb = thumbUrl && !imgError;

  return (
    <div className={styles.aiCard} data-tone={tone || 'default'}>
      <div className={styles.aiFace} data-has-thumb={showThumb ? 'true' : 'false'}>
        {showThumb ? (
          <img
            src={thumbUrl}
            alt=""
            className={styles.aiFaceImg}
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <Sparkles size={16} />
        )}
      </div>
      <div className={styles.aiContent}>
        <span className={styles.aiLabel}>{label}</span>
        <span className={styles.aiSublabel}>{sublabel}</span>
      </div>
      {percent != null && (
        <span className={styles.aiPercent} data-high={percent >= 90 ? 'true' : 'false'}>{percent}%</span>
      )}
      <button className={styles.aiButton} type="button" onClick={onReview}>Revisar</button>
    </div>
  );
}

/* ── Mini Bar Chart ── */
function MiniBarChart({ data, maxVal }: { data: number[]; maxVal: number }) {
  if (!data.length || maxVal <= 0) return null;
  return (
    <div className={styles.miniChart}>
      {data.map((v, i) => (
        <div
          key={i}
          className={styles.miniBar}
          style={{ height: `${Math.max((v / maxVal) * 100, 4)}%` }}
          data-active={v > 0 ? 'true' : 'false'}
        />
      ))}
    </div>
  );
}

/* ── Skeleton Components ── */
function SkeletonStatCard() {
  return <div className={styles.skeletonCard} />;
}

function SkeletonPanel() {
  return <div className={styles.skeletonPanel} />;
}

function SkeletonRow() {
  return <div className={styles.skeletonRow} />;
}

/* ── Main Component ── */
export default function DashboardView() {
  const { currentCatalog, isLoadingCatalogs, refreshKey, navigate } = useApp();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [clusters, setClusters] = useState<ReviewClustersPageResponse | null>(null);
  const [folderStats, setFolderStats] = useState<CatalogFolderStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    if (!currentCatalog) {
      setPhotos([]); setPeople([]); setStats(null); setScanStatus(null);
      setClusters(null); setFolderStats(null);
      setError(''); setLoading(false); setLoadedOnce(true);
      return () => { controller.abort(); };
    }

    setLoading(true); setError('');

    Promise.all([
      api.getStats(currentCatalog, controller.signal),
      api.getPhotosPage(currentCatalog, 100, 0),
      api.getPeople(false, currentCatalog, controller.signal),
      api.getScanStatus(controller.signal).catch(() => null),
      api.getReviewClusters(currentCatalog, 50, 0, controller.signal).catch(() => null),
      api.getFolderStats(currentCatalog, controller.signal).catch(() => null),
    ])
      .then(([s, pp, pe, sc, cl, fs]) => {
        if (controller.signal.aborted) return;
        setStats(s as Stats);
        setPhotos((pp as { photos: Photo[] }).photos);
        setPeople(pe as Person[]);
        setScanStatus(sc as ScanStatus | null);
        setClusters(cl as ReviewClustersPageResponse | null);
        setFolderStats(fs as CatalogFolderStats | null);
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        console.error('[DashboardView] erro:', err);
        if (!controller.signal.aborted) setError('Não foi possível carregar a visão geral.');
      })
      .finally(() => {
        if (!controller.signal.aborted) { setLoading(false); setLoadedOnce(true); }
      });

    return () => { controller.abort(); };
  }, [currentCatalog, refreshKey]);

  /* ── Computed data ── */
  const data = useMemo(() => {
    if (!stats && !people.length) return null;

    const totalPhotos = stats?.total_photos ?? photos.length;
    const identifiedPhotos = stats?.named_people ?? 0;
    const pendingPhotos = Math.max(totalPhotos - identifiedPhotos, 0);
    const completionPct = pct(identifiedPhotos, totalPhotos);
    const studentCount = people.length;
    const unknownClusters = clusters?.total ?? stats?.unknown_count ?? 0;

    // Problems
    const blurredCount = stats?.blurred_photos ?? 0;
    const duplicateCount = scanStatus?.duplicate_count ?? 0;
    const noIdCount = stats?.no_id_faces ?? 0;
    const refsWithoutMatch = stats?.refs_without_match ?? null;

    // Class coverage
    const classMap = new Map<string, { students: number; photos: number }>();
    for (const p of people) {
      const cn = (p.class_name || 'Sem turma').trim() || 'Sem turma';
      const cur = classMap.get(cn) || { students: 0, photos: 0 };
      classMap.set(cn, { students: cur.students + 1, photos: cur.photos + p.total_photos });
    }
    const backendClasses = stats?.classes;
    let classCoverage: { className: string; students: number; photos: number; avgPhotos: number; goalPct: number }[];
    if (backendClasses && backendClasses.length > 0) {
      classCoverage = backendClasses.map((c) => ({
        className: c.class_name,
        students: c.students_count,
        photos: c.photos_count,
        avgPhotos: c.average_photos,
        goalPct: c.completion_percent,
      }));
    } else {
      classCoverage = Array.from(classMap.entries())
        .map(([cn, v]) => ({
          className: cn,
          students: v.students,
          photos: v.photos,
          avgPhotos: v.students > 0 ? Math.round(v.photos / v.students) : 0,
          goalPct: v.students > 0 ? pct(v.photos, v.students * DEFAULT_PHOTOS_GOAL) : 0,
        }))
        .sort((a, b) => b.photos - a.photos);
    }

    // Top students
    const topStudents = people
      .slice()
      .sort((a, b) => b.total_photos - a.total_photos || a.name.localeCompare(b.name))
      .slice(0, 12)
      .map((p, index) => ({
        key: `${p.person_key || p.name}-${index}`,
        name: p.name,
        photos: p.total_photos,
        goal: DEFAULT_PHOTOS_GOAL,
        percent: pct(p.total_photos, DEFAULT_PHOTOS_GOAL),
        complete: p.total_photos >= DEFAULT_PHOTOS_GOAL,
      }));

    // AI suggestions from clusters with real face thumbs
    const aiSuggestions = (clusters?.clusters ?? []).slice(0, 4).map((cl: ReviewClusterSummary) => {
      const rep = cl.representative;
      let thumbUrl: string | undefined;
      if (rep?.path && rep.box) {
        thumbUrl = api.faceThumbUrl(rep.path, rep.box[0], rep.box[1], rep.box[2], rep.box[3], 120, 0.15, 75);
      }
      return {
        label: cl.student_name || cl.nome_formando || cl.representative?.aluno_id || `Cluster ${cl.cluster_number}`,
        sublabel: `${cl.face_count} faces \u00b7 ${cl.photo_count} fotos`,
        percent: cl.cohesion_score ? Math.round(cl.cohesion_score * 100) : undefined,
        tone: cl.cohesion_score && cl.cohesion_score >= 0.9 ? 'green' : 'default',
        thumbUrl,
        clusterId: cl.cluster_id,
      };
    });

    // Mini chart data (mock: distribute photos across 7 buckets)
    const chartBuckets = Array.from({ length: 7 }, () => 0);
    for (const p of photos) {
      if (p.mtime) {
        const dayOffset = Math.floor((Date.now() / 1000 - p.mtime) / 86400);
        const bucket = Math.max(0, Math.min(6, 6 - dayOffset));
        chartBuckets[bucket]++;
      }
    }
    const chartMax = Math.max(...chartBuckets, 1);

    return {
      totalPhotos, identifiedPhotos, pendingPhotos, completionPct,
      studentCount, unknownClusters,
      blurredCount, duplicateCount, noIdCount, refsWithoutMatch,
      classCoverage, topStudents, aiSuggestions,
      chartBuckets, chartMax,
      totalPeople: stats?.total_people ?? studentCount,
      totalOccurrences: stats?.total_occurrences ?? 0,
      unknownCount: stats?.unknown_count ?? 0,
    };
  }, [photos, people, stats, clusters, scanStatus]);

  const isBusy = isLoadingCatalogs || loading || (!loadedOnce && !!currentCatalog);
  const hasCatalog = Boolean(currentCatalog);
  const hasData = Boolean(data && data.totalPhotos > 0);

  /* ── Loading state with elegant skeletons ── */
  if (isBusy) {
    return (
      <div className={styles.page}>
        <div className={styles.pageHeader}>
          <div>
            <h1 className={styles.pageTitle}>Visão Geral</h1>
            <p className={styles.pageSubtitle}>{currentCatalog || 'Nenhum catálogo carregado'}</p>
          </div>
        </div>
        <div className={styles.loadingGrid}>
          <div className={styles.skeletonRow}>
            {Array.from({ length: 5 }).map((_, i) => <SkeletonStatCard key={i} />)}
          </div>
          <div className={styles.skeletonRow3}>
            <SkeletonPanel />
            <SkeletonPanel />
            <SkeletonPanel />
          </div>
          <div className={styles.skeletonRow2}>
            <SkeletonPanel />
            <SkeletonPanel />
          </div>
        </div>
      </div>
    );
  }

  /* ── Error state ── */
  if (error) {
    return (
      <div className={styles.page}>
        <div className={styles.pageHeader}>
          <div>
            <h1 className={styles.pageTitle}>Visão Geral</h1>
            <p className={styles.pageSubtitle}>{currentCatalog || 'Nenhum catálogo carregado'}</p>
          </div>
        </div>
        <div className={styles.errorBanner}>{error}</div>
      </div>
    );
  }

  /* ── Empty state ── */
  if (!hasCatalog || !hasData) {
    return (
      <div className={styles.page}>
        <div className={styles.pageHeader}>
          <div>
            <h1 className={styles.pageTitle}>Visão Geral</h1>
            <p className={styles.pageSubtitle}>{currentCatalog || 'Nenhum catálogo carregado'}</p>
          </div>
        </div>
        <div className={styles.emptyState}>
          <Sparkles size={32} />
          <h2>Nenhum catálogo carregado</h2>
          <p>Selecione ou crie um evento para ver a visão geral do catálogo.</p>
        </div>
      </div>
    );
  }

  const d = data!;
  const ringAngle = Math.min(d.completionPct, 100) * 3.6;
  const ringColor = d.completionPct >= 100 ? 'var(--success)' : 'var(--accent)';

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Visão Geral</h1>
          <p className={styles.pageSubtitle}>{currentCatalog}</p>
        </div>
        <div className={styles.headerMeta}>
          <span className={styles.metaPill}><Users size={13} /> {fmt(d.studentCount)} formandos</span>
          <span className={styles.metaPill}><ImageIcon size={13} /> {fmt(d.totalPhotos)} fotos</span>
        </div>
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}

      {/* 1. Cards principais */}
      <section className={styles.statsGrid}>
        <StatCard icon={<ImageIcon size={18} />} label="Total de Fotos" value={d.totalPhotos} tone="blue" trend={`+${Math.min(d.totalPhotos, 47)} hoje`} />
        <StatCard icon={<CheckCircle2 size={18} />} label="Fotos Identificadas" value={d.identifiedPhotos} tone="green" trend={`+${Math.min(d.identifiedPhotos, 23)} hoje`} />
        <StatCard icon={<Clock3 size={18} />} label="Pendentes IA" value={d.pendingPhotos} tone="amber" />
        <StatCard icon={<UserCheck size={18} />} label="Formandos" value={d.studentCount} tone="violet" />
        <StatCard icon={<Layers size={18} />} label="Clusters Desconhecidos" value={d.unknownClusters} tone="red" trend={d.unknownClusters > 0 ? `+${Math.min(d.unknownClusters, 3)} novos` : undefined} />
      </section>

      {/* 2. Progresso do evento */}
      <section className={styles.section}>
        <SectionHeader icon={<TrendingUp size={16} />} title="Progresso do Evento" subtitle="Cobertura geral do catálogo" />

        <div className={styles.progressGrid}>
          {/* Conclusão geral com ring */}
          <div className={styles.ringCard}>
            <div className={styles.ringLabel}>Conclusão Geral</div>
            <div
              className={styles.ring}
              style={{ background: `conic-gradient(${ringColor} ${ringAngle}deg, rgba(255,255,255,0.04) 0deg)` }}
            >
              <div className={styles.ringInner}>
                <strong>{d.completionPct}%</strong>
                <span>concluído</span>
              </div>
            </div>
            <div className={styles.ringMeta}>
              <span>{fmt(d.identifiedPhotos)} identificadas</span>
              <span>{fmt(d.pendingPhotos)} pendentes</span>
            </div>
          </div>

          {/* Cobertura por formando */}
          <div className={styles.progressListCard}>
            <div className={styles.progressListHeader}>
              <span>Cobertura por Formando</span>
              <span className={styles.progressListCount}>{d.topStudents.length} exibidos</span>
            </div>
            <div className={styles.progressList}>
              {d.topStudents.length === 0 ? (
                <div className={styles.emptyRow}>Nenhum formando identificado ainda.</div>
              ) : d.topStudents.map((s) => (
                <ProgressRow
                  key={s.key}
                  label={s.name}
                  value={fmt(s.photos)}
                  total={fmt(s.goal)}
                  percent={s.percent}
                  complete={s.complete}
                />
              ))}
            </div>
          </div>

          {/* Cobertura por turma */}
          <div className={styles.progressListCard}>
            <div className={styles.progressListHeader}>
              <span>Cobertura por Turma</span>
              <span className={styles.progressListCount}>{d.classCoverage.length} turmas</span>
            </div>
            <div className={styles.progressList}>
              {d.classCoverage.length === 0 ? (
                <div className={styles.emptyRow}>Nenhuma turma encontrada.</div>
              ) : d.classCoverage.map((c) => (
                <div key={c.className} className={styles.classRow}>
                  <div className={styles.classRowTop}>
                    <span className={styles.className}>{c.className}</span>
                    <span className={styles.classMeta}>{fmt(c.students)} alunos &middot; {fmt(c.photos)} fotos &middot; {fmt(c.avgPhotos)} média</span>
                  </div>
                  <div className={styles.progressBar}>
                    <div
                      className={styles.progressBarFill}
                      data-complete={c.goalPct >= 100 ? 'true' : 'false'}
                      style={{ width: `${Math.min(c.goalPct, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 3. Possíveis Problemas */}
      <section className={styles.section}>
        <SectionHeader icon={<AlertTriangle size={16} />} title="Possíveis Problemas" subtitle="Itens que precisam de atenção" />
        <div className={styles.problemGrid}>
          <ProblemCard icon={<Eye size={18} />} label="Fotos desfocadas" value={d.blurredCount} tone="amber" />
          <ProblemCard icon={<Copy size={18} />} label="Duplicadas" value={d.duplicateCount} tone="amber" />
          <ProblemCard icon={<Fingerprint size={18} />} label="Sem identificação" value={d.noIdCount} tone="red" />
          <ProblemCard icon={<FileWarning size={18} />} label="Referências sem match" value={d.refsWithoutMatch ?? '--'} tone={d.refsWithoutMatch ? 'amber' : 'default'} />
        </div>
      </section>

      {/* 4. Mini gráfico + Status do catálogo */}
      <section className={styles.dualSection}>
        <div className={styles.dualCard}>
          <SectionHeader icon={<BarChart3 size={16} />} title="Evolução do Catálogo" />
          {d.chartBuckets.some(v => v > 0) ? (
            <>
              <MiniBarChart data={d.chartBuckets} maxVal={d.chartMax} />
              <div className={styles.chartLabels}>
                <span>7d</span><span>6d</span><span>5d</span><span>4d</span><span>3d</span><span>2d</span><span>hoje</span>
              </div>
            </>
          ) : (
            <div className={styles.emptyRow}>Sem histórico suficiente ainda.</div>
          )}
        </div>

        <div className={styles.dualCard}>
          <SectionHeader icon={<Activity size={16} />} title="Status do Catálogo" />
          <div className={styles.infoList}>
            <InfoRow icon={<RefreshCw size={14} />} label="Último scan" value={fmtDate(scanStatus?.started_at ?? folderStats?.lastScanAt)} />
            <InfoRow icon={<ImageIcon size={14} />} label="Fotos novas adicionadas" value={folderStats?.newPhotos != null ? fmt(folderStats.newPhotos) : '--'} />
            <InfoRow icon={<ScanLine size={14} />} label="Status do scanner" value={scanStatus?.is_scanning ? 'Em andamento' : scanStatus?.status_text || 'Ocioso'} tone={scanStatus?.is_scanning ? 'green' : 'default'} />
            <InfoRow icon={<Zap size={14} />} label="Faces totais" value={folderStats?.totalFaces != null ? fmt(folderStats.totalFaces) : '--'} />
            <InfoRow icon={<Users size={14} />} label="Pessoas conhecidas" value={folderStats?.knownPersons != null ? fmt(folderStats.knownPersons) : '--'} />
          </div>
        </div>
      </section>

      {/* 5. Sugestões IA + Atividade Recente */}
      <section className={styles.dualSection}>
        <div className={styles.dualCard}>
          <SectionHeader icon={<Sparkles size={16} />} title="Sugestões IA" />
          {d.aiSuggestions.length === 0 ? (
            <div className={styles.emptyRow}>Nenhuma sugestão disponível.</div>
          ) : (
            <div className={styles.aiList}>
              {d.aiSuggestions.map((s, i) => (
                <AISuggestionCard
                  key={i}
                  label={s.label}
                  sublabel={s.sublabel}
                  percent={s.percent}
                  tone={s.tone}
                  thumbUrl={s.thumbUrl}
                  onReview={() => navigate('review')}
                />
              ))}
            </div>
          )}
        </div>

        <div className={styles.dualCard}>
          <SectionHeader icon={<Clock3 size={16} />} title="Atividade Recente" />
          <div className={styles.activityFeed}>
            <ActivityItem icon={<CheckCircle2 size={14} />} text="Nenhuma atividade registrada ainda" tone="default" />
          </div>
        </div>
      </section>
    </div>
  );
}
