import { useEffect, useMemo, useState } from 'react';
import {
  Image as ImageIcon,
  Users,
  UserCheck,
  Clock3,
  CircleGauge,
  Layers,
  AlertTriangle,
  Activity,
  Sparkles,
  RefreshCw,
  Eye,
  Copy,
  HelpCircle,
  Zap,
  CheckCircle2,
  XCircle,
  ScanLine,
  TrendingUp,
} from 'lucide-react';
import {
  api,
  type Photo,
  type Person,
  type Stats,
  type ScanStatus,
  type ReviewClustersPageResponse,
  type CatalogFolderStats,
} from '../services/api';
import { useApp } from '../context/AppContext';
import styles from './DashboardView.module.css';

export const DEFAULT_PHOTOS_GOAL = 50;

const UNKNOWN_LABELS = new Set([
  'unknown', 'desconhecido', 'sem_nome', 'nao_mapeado', '__unknown__',
]);

function isKnownFaceLabel(value: string | null | undefined) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (UNKNOWN_LABELS.has(normalized)) return false;
  if (normalized.startsWith('pessoa ')) return false;
  return true;
}

function hasKnownFace(photo: Photo) {
  return Boolean(photo.faces?.some((f) => isKnownFaceLabel(f.aluno_id)));
}

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

/* ── Stat Card ── */
function StatCard({ icon, label, value, tone, caption }: {
  icon: React.ReactNode; label: string; value: string | number; tone: string; caption?: string;
}) {
  return (
    <article className={styles.statCard} data-tone={tone}>
      <div className={styles.statIcon}>{icon}</div>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{typeof value === 'number' ? fmt(value) : value}</div>
      {caption && <div className={styles.statCaption}>{caption}</div>}
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

/* ── Problem Row ── */
function ProblemRow({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: string | number; tone: string;
}) {
  return (
    <div className={styles.problemRow}>
      <div className={styles.problemIcon} data-tone={tone}>{icon}</div>
      <span className={styles.problemLabel}>{label}</span>
      <span className={styles.problemValue} data-tone={tone}>{typeof value === 'number' ? fmt(value) : value}</span>
    </div>
  );
}

/* ── Activity Row ── */
function ActivityRow({ icon, text, time }: {
  icon: React.ReactNode; text: string; time?: string;
}) {
  return (
    <div className={styles.activityRow}>
      <div className={styles.activityIcon}>{icon}</div>
      <span className={styles.activityText}>{text}</span>
      {time && <span className={styles.activityTime}>{time}</span>}
    </div>
  );
}

/* ── Main Component ── */
export default function DashboardView() {
  const { currentCatalog, isLoadingCatalogs, refreshKey } = useApp();
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
    let cancelled = false;
    if (!currentCatalog) {
      setPhotos([]); setPeople([]); setStats(null); setScanStatus(null);
      setClusters(null); setFolderStats(null);
      setError(''); setLoading(false); setLoadedOnce(true);
      return () => { cancelled = true; };
    }

    setLoading(true); setError('');

    Promise.all([
      api.getStats(currentCatalog),
      api.getAllPhotos(currentCatalog),
      api.getPeople(false),
      api.getScanStatus().catch(() => null),
      api.getReviewClusters(currentCatalog, 50, 0).catch(() => null),
      api.getFolderStats(currentCatalog).catch(() => null),
    ])
      .then(([s, ph, pe, sc, cl, fs]) => {
        if (cancelled) return;
        setStats(s as Stats);
        setPhotos(ph as Photo[]);
        setPeople(pe as Person[]);
        setScanStatus(sc as ScanStatus | null);
        setClusters(cl as ReviewClustersPageResponse | null);
        setFolderStats(fs as CatalogFolderStats | null);
      })
      .catch((err) => {
        console.error('[DashboardView] erro:', err);
        if (!cancelled) setError('Não foi possível carregar a visão geral.');
      })
      .finally(() => {
        if (!cancelled) { setLoading(false); setLoadedOnce(true); }
      });

    return () => { cancelled = true; };
  }, [currentCatalog, refreshKey]);

  /* ── Computed data ── */
  const data = useMemo(() => {
    if (!photos.length && !people.length && !stats) return null;

    const totalPhotos = photos.length;
    const identifiedPhotos = photos.filter(hasKnownFace).length;
    const pendingPhotos = Math.max(totalPhotos - identifiedPhotos, 0);
    const completionPct = pct(identifiedPhotos, totalPhotos);
    const studentCount = people.length;
    const unknownClusters = clusters?.total ?? stats?.unknown_count ?? 0;

    // Problems
    const blurredCount = photos.filter((p) => p.blur_status === 'blurry' || p.blur_label === 'Embaçada').length;
    const duplicateCount = scanStatus?.duplicate_count ?? 0;
    const noIdCount = photos.filter((p) => !hasKnownFace(p) && p.faces && p.faces.length > 0).length;

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
      .map((p) => ({
        name: p.name,
        photos: p.total_photos,
        goal: DEFAULT_PHOTOS_GOAL,
        percent: pct(p.total_photos, DEFAULT_PHOTOS_GOAL),
        complete: p.total_photos >= DEFAULT_PHOTOS_GOAL,
      }));

    return {
      totalPhotos, identifiedPhotos, pendingPhotos, completionPct,
      studentCount, unknownClusters,
      blurredCount, duplicateCount, noIdCount,
      classCoverage, topStudents,
      totalPeople: stats?.total_people ?? studentCount,
      totalOccurrences: stats?.total_occurrences ?? 0,
      unknownCount: stats?.unknown_count ?? 0,
    };
  }, [photos, people, stats, clusters, scanStatus]);

  const isBusy = isLoadingCatalogs || loading || (!loadedOnce && !!currentCatalog);
  const hasCatalog = Boolean(currentCatalog);
  const hasData = Boolean(data && data.totalPhotos > 0);

  /* ── Loading state ── */
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
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className={styles.skeletonCard} />)}
          </div>
          <div className={styles.skeletonRow}>
            {Array.from({ length: 3 }).map((_, i) => <div key={i} className={styles.skeletonPanel} />)}
          </div>
        </div>
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
        {error && <div className={styles.errorBanner}>{error}</div>}
        <div className={styles.emptyState}>
          <Sparkles size={28} />
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
        <StatCard icon={<ImageIcon size={16} />} label="Total de Fotos" value={d.totalPhotos} tone="blue" caption="Arquivos no catálogo" />
        <StatCard icon={<CheckCircle2 size={16} />} label="Fotos Identificadas" value={d.identifiedPhotos} tone="green" caption="Com vínculo confirmado" />
        <StatCard icon={<Clock3 size={16} />} label="Pendentes IA" value={d.pendingPhotos} tone="amber" caption="Aguardando processamento" />
        <StatCard icon={<UserCheck size={16} />} label="Formandos" value={d.studentCount} tone="violet" caption="Pessoas cadastradas" />
        <StatCard icon={<Layers size={16} />} label="Clusters Desconhecidos" value={d.unknownClusters} tone="red" caption="Agrupamentos sem identificação" />
      </section>

      {/* 2. Progresso do evento */}
      <section className={styles.section}>
        <SectionHeader icon={<TrendingUp size={15} />} title="Progresso do Evento" subtitle="Cobertura geral do catálogo" />

        <div className={styles.progressGrid}>
          {/* Conclusão geral com ring */}
          <div className={styles.ringCard}>
            <div className={styles.ringLabel}>Conclusão Geral</div>
            <div
              className={styles.ring}
              style={{ background: `conic-gradient(${ringColor} ${ringAngle}deg, var(--bg-tertiary) 0deg)` }}
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
                  key={s.name}
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

      {/* 3 + 4. Status do catálogo + Possíveis problemas */}
      <section className={styles.dualSection}>
        <div className={styles.dualCard}>
          <SectionHeader icon={<Activity size={15} />} title="Status do Catálogo" />
          <div className={styles.infoList}>
            <InfoRow icon={<RefreshCw size={14} />} label="Último scan" value={fmtDate(scanStatus?.started_at ?? folderStats?.lastScanAt)} />
            <InfoRow icon={<ImageIcon size={14} />} label="Fotos novas adicionadas" value={folderStats?.newPhotos != null ? fmt(folderStats.newPhotos) : '--'} />
            <InfoRow icon={<ScanLine size={14} />} label="Status do scanner" value={scanStatus?.is_scanning ? 'Em andamento' : scanStatus?.status_text || 'Ocioso'} tone={scanStatus?.is_scanning ? 'green' : 'default'} />
            <InfoRow icon={<Zap size={14} />} label="Faces totais" value={folderStats?.totalFaces != null ? fmt(folderStats.totalFaces) : '--'} />
            <InfoRow icon={<Users size={14} />} label="Pessoas conhecidas" value={folderStats?.knownPersons != null ? fmt(folderStats.knownPersons) : '--'} />
          </div>
        </div>

        <div className={styles.dualCard}>
          <SectionHeader icon={<AlertTriangle size={15} />} title="Possíveis Problemas" />
          <div className={styles.infoList}>
            <ProblemRow icon={<Eye size={14} />} label="Fotos desfocadas" value={d.blurredCount} tone="amber" />
            <ProblemRow icon={<Copy size={14} />} label="Duplicadas" value={d.duplicateCount} tone="amber" />
            <ProblemRow icon={<HelpCircle size={14} />} label="Referências sem match" value="--" tone="default" />
            <ProblemRow icon={<XCircle size={14} />} label="Fotos sem identificação" value={d.noIdCount} tone="red" />
          </div>
        </div>
      </section>

      {/* 5 + 6. Atividade recente + Sugestões IA */}
      <section className={styles.dualSection}>
        <div className={styles.dualCard}>
          <SectionHeader icon={<Clock3 size={15} />} title="Atividade Recente" />
          <div className={styles.infoList}>
            <ActivityRow icon={<CheckCircle2 size={14} />} text="Nenhuma atividade registrada ainda" />
          </div>
        </div>

        <div className={styles.dualCard}>
          <SectionHeader icon={<Sparkles size={15} />} title="Sugestões IA" />
          <div className={styles.infoList}>
            <ActivityRow icon={<Sparkles size={14} />} text="Nenhuma sugestão disponível" />
          </div>
        </div>
      </section>
    </div>
  );
}
