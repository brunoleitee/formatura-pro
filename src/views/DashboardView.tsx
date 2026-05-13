import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  CheckCircle2,
  Clock3,
  CircleGauge,
  Image as ImageIcon,
  Users,
  Sparkles,
} from 'lucide-react';
import { api, type Photo, type Person, type Stats } from '../services/api';
import { useApp } from '../context/AppContext';
import styles from './DashboardView.module.css';

export const DEFAULT_PHOTOS_GOAL = 50;

type DashboardStudent = {
  name: string;
  className: string;
  photos: number;
  goal: number;
};

type DashboardClassCoverage = {
  className: string;
  students: number;
  photos: number;
  avgPhotos: number;
  goalPercent: number;
};

type DashboardSummary = {
  catalog: string;
  totalPhotos: number;
  processedPhotos: number;
  pendingPhotos: number;
  completionPercent: number;
  students: DashboardStudent[];
  classCoverage: DashboardClassCoverage[];
  stats: (Stats & {
    total_photos?: number;
    avg_photos_per_person?: number;
    named_people?: number;
    discarded_photos?: number;
  }) | null;
};

const UNKNOWN_LABELS = new Set([
  'unknown',
  'desconhecido',
  'sem_nome',
  'nao_mapeado',
  'nÃ£o_mapeado',
  '__unknown__',
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
  return Boolean(photo.faces?.some((face) => isKnownFaceLabel(face.aluno_id)));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('pt-BR').format(value);
}

function toNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export default function DashboardView() {
  const { currentCatalog, isLoadingCatalogs, refreshKey } = useApp();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    if (!currentCatalog) {
      setSummary(null);
      setError('');
      setLoading(false);
      setLoadedOnce(true);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setError('');

    Promise.all([
      api.getStats(currentCatalog),
      api.getAllPhotos(currentCatalog),
      api.getPeople(false),
    ])
      .then(([stats, photos, people]) => {
        if (cancelled) return;

        const typedStats = stats as DashboardSummary['stats'];
        const totalPhotos = photos.length;
        const processedPhotos = photos.reduce((count, photo) => count + (hasKnownFace(photo) ? 1 : 0), 0);
        const pendingPhotos = Math.max(totalPhotos - processedPhotos, 0);
        const completionPercent = totalPhotos > 0 ? Math.round((processedPhotos / totalPhotos) * 100) : 0;
        const students = (people as Person[])
          .slice()
          .sort((a, b) => b.total_photos - a.total_photos || a.name.localeCompare(b.name))
          .map((person) => ({
            name: person.name,
            className: (person.class_name || 'Sem turma').trim() || 'Sem turma',
            photos: person.total_photos,
            goal: DEFAULT_PHOTOS_GOAL,
          }));

        const classCoverageMap = new Map<string, { students: number; photos: number }>();
        for (const person of people as Person[]) {
          const className = (person.class_name || 'Sem turma').trim() || 'Sem turma';
          const current = classCoverageMap.get(className) || { students: 0, photos: 0 };
          classCoverageMap.set(className, {
            students: current.students + 1,
            photos: current.photos + person.total_photos,
          });
        }
        const backendClasses = (typedStats as { classes?: Array<{ class_name: string; students_count: number; photos_count: number; average_photos: number; completion_percent: number }> }).classes;
        let classCoverage;
        if (backendClasses && backendClasses.length > 0) {
          classCoverage = backendClasses.map((c: { class_name: string; students_count: number; photos_count: number; average_photos: number; completion_percent: number }) => ({
            className: c.class_name,
            students: c.students_count,
            photos: c.photos_count,
            avgPhotos: c.average_photos,
            goalPercent: c.completion_percent,
          }));
        } else {
          classCoverage = Array.from(classCoverageMap.entries())
            .map(([className, value]) => ({
              className,
              students: value.students,
              photos: value.photos,
              avgPhotos: value.students > 0 ? value.photos / value.students : 0,
              goalPercent: value.students > 0
                ? Math.round((value.photos / (value.students * DEFAULT_PHOTOS_GOAL)) * 100)
                : 0,
            }))
            .sort((a, b) => b.photos - a.photos || a.className.localeCompare(b.className));
        }

        setSummary({
          catalog: currentCatalog,
          totalPhotos,
          processedPhotos,
          pendingPhotos,
          completionPercent,
          students,
          classCoverage,
          stats: typedStats,
        });
      })
      .catch((err) => {
        console.error('[DashboardView] erro ao carregar resumo:', err);
        if (!cancelled) {
          setSummary(null);
          setError('Não foi possível carregar o painel.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setLoadedOnce(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentCatalog, refreshKey]);

  const isBusy = isLoadingCatalogs || loading || (!loadedOnce && !summary && !error && !!currentCatalog);
  const hasCatalog = Boolean(currentCatalog);
  const hasRealData = Boolean(summary && summary.totalPhotos > 0);

  const topCards = useMemo(() => {
    if (!summary) return [];

    const percent = summary.completionPercent;
    return [
      {
        label: 'Total de Fotos',
        value: summary.totalPhotos,
        icon: <ImageIcon size={16} />,
        tone: 'blue',
        caption: 'Arquivos disponíveis no catálogo',
      },
      {
        label: 'Processadas',
        value: summary.processedPhotos,
        icon: <CheckCircle2 size={16} />,
        tone: 'green',
        caption: 'Fotos com vínculo identificado',
      },
      {
        label: 'Pendentes',
        value: summary.pendingPhotos,
        icon: <Clock3 size={16} />,
        tone: 'amber',
        caption: 'Fotos ainda sem cobertura',
      },
      {
        label: 'Conclusão do Projeto',
        value: `${percent}%`,
        icon: <CircleGauge size={16} />,
        tone: 'violet',
        caption: 'Leitura geral do evento',
        progress: percent,
      },
    ];
  }, [summary]);

  const ringAngle = Math.max(0, Math.min(100, summary?.completionPercent ?? 0)) * 3.6;
  const ringColor = (summary?.completionPercent ?? 0) >= 100 ? '#22c55e' : '#6d7dff';

  if (isBusy) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Painel</h1>
            <p className={styles.subtitle}>{currentCatalog || 'Nenhum catálogo carregado'}</p>
          </div>
          <div className={styles.headerMeta}>
            <span className={styles.metaPill}><Users size={14} /> 0 alunos</span>
            <span className={styles.metaPill}><BarChart3 size={14} /> Meta: {DEFAULT_PHOTOS_GOAL}</span>
          </div>
        </div>
        <div className={styles.loadingGrid} aria-busy="true">
          <div className={styles.skeletonRow}>
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className={styles.skeletonCard} />)}
          </div>
          <div className={styles.skeletonPanel} />
        </div>
      </div>
    );
  }

  if (!hasCatalog || !hasRealData) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Painel</h1>
            <p className={styles.subtitle}>{currentCatalog || 'Nenhum catálogo carregado'}</p>
          </div>
          <div className={styles.headerMeta}>
            <span className={styles.metaPill}><Users size={14} /> {summary ? formatNumber(summary.students.length) : '0'} alunos</span>
            <span className={styles.metaPill}><BarChart3 size={14} /> Meta: {DEFAULT_PHOTOS_GOAL}</span>
          </div>
        </div>

        {error && <div className={styles.errorBanner}>{error}</div>}

        <div className={styles.emptyState}>
          <Sparkles size={28} />
          <h2>Nenhum catálogo carregado</h2>
          <p>Selecione ou crie um evento para ver o resumo do painel.</p>
        </div>
      </div>
    );
  }

  const dashboard = summary as DashboardSummary;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Painel</h1>
          <p className={styles.subtitle}>{currentCatalog || 'Nenhum catálogo carregado'}</p>
        </div>
        <div className={styles.headerMeta}>
          <span className={styles.metaPill}><Users size={14} /> {formatNumber(dashboard.students.length)} alunos</span>
          <span className={styles.metaPill}><BarChart3 size={14} /> Meta: {DEFAULT_PHOTOS_GOAL}</span>
        </div>
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}

      <section className={styles.cardsGrid}>
        {topCards.map((card) => (
          <article key={card.label} className={styles.metricCard} data-tone={card.tone}>
            <div className={styles.metricIcon}>{card.icon}</div>
            <div className={styles.metricLabel}>{card.label}</div>
            <div className={styles.metricValue}>{String(card.value)}</div>
            <div className={styles.metricCaption}>{card.caption}</div>
            {card.progress !== undefined && (
              <div className={styles.metricProgressTrack}>
                <div
                  className={styles.metricProgressFill}
                  style={{ width: `${Math.min(card.progress, 100)}%` }}
                />
              </div>
            )}
          </article>
        ))}
      </section>

      <section className={styles.coverageSection}>
        <div className={styles.coverageHeader}>
          <div>
            <h2>Cobertura do Projeto</h2>
            <p>Fotos por aluno</p>
          </div>
          <div className={styles.coverageStats}>
            <span>{dashboard.students.length} alunos</span>
            <span>{formatNumber(dashboard.totalPhotos)} fotos</span>
          </div>
        </div>

        <div className={styles.coverageList}>
          {dashboard.students.length === 0 ? (
            <div className={styles.coverageEmpty}>Nenhum formando identificado ainda.</div>
          ) : (
            dashboard.students.map((student) => {
              const percent = Math.min((student.photos / student.goal) * 100, 100);
              const overGoal = student.photos >= student.goal;
              return (
                <div key={student.name} className={styles.coverageRow} data-complete={overGoal ? 'true' : 'false'}>
                  <div className={styles.coverageRowTop}>
                    <span className={styles.coverageName}>{student.name}</span>
                    <span className={styles.coverageCount}>
                      {formatNumber(student.photos)}/{formatNumber(student.goal)}
                    </span>
                  </div>
                  <div className={styles.coverageBar}>
                    <div
                      className={styles.coverageBarFill}
                      data-complete={overGoal ? 'true' : 'false'}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <section className={styles.classCoverageSection}>
        <div className={styles.coverageHeader}>
          <div>
            <h2>Cobertura por turma</h2>
            <p>Fotos, alunos e meta média por classe</p>
          </div>
        </div>

        <div className={styles.classCoverageGrid}>
          {(dashboard.classCoverage.length === 0 ? [{ className: 'Sem turma', students: 0, photos: 0, avgPhotos: 0, goalPercent: 0 }] : dashboard.classCoverage).map((group) => (
            <article key={group.className} className={styles.classCoverageCard}>
              <div className={styles.classCoverageTop}>
                <strong>{group.className}</strong>
                <span>{formatNumber(group.goalPercent)}%</span>
              </div>
              <div className={styles.classCoverageMeta}>
                <span>{formatNumber(group.students)} alunos</span>
                <span>{formatNumber(group.photos)} fotos</span>
                <span>{formatNumber(Math.round(group.avgPhotos))} média</span>
              </div>
              <div className={styles.coverageBar}>
                <div
                  className={styles.coverageBarFill}
                  data-complete={group.goalPercent >= 100 ? 'true' : 'false'}
                  style={{ width: `${Math.min(group.goalPercent, 100)}%` }}
                />
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.bottomGrid}>
        <article className={styles.summaryCard}>
          <div className={styles.summaryLabel}>Resumo do catálogo</div>
          <div className={styles.summaryList}>
            <div><span>Total de pessoas</span><strong>{formatNumber(toNumber(dashboard.stats?.total_people) || dashboard.students.length)}</strong></div>
            <div><span>Ocorrências</span><strong>{formatNumber(toNumber(dashboard.stats?.total_occurrences))}</strong></div>
            <div><span>Fotos com faces</span><strong>{formatNumber(toNumber(dashboard.stats?.photos_with_faces))}</strong></div>
            <div><span>Sem identificação</span><strong>{formatNumber(toNumber(dashboard.stats?.unknown_count))}</strong></div>
          </div>
        </article>

        <article className={styles.ringCard}>
          <div className={styles.ringHeader}>
            <div>
              <div className={styles.summaryLabel}>Conclusão do projeto</div>
              <p>Visão geral do evento atual</p>
            </div>
          </div>
          <div
            className={styles.ring}
            style={{ background: `conic-gradient(${ringColor} ${ringAngle}deg, rgba(36, 47, 66, 0.92) 0deg)` }}
          >
            <div className={styles.ringInner}>
              <strong>{dashboard.completionPercent}%</strong>
              <span>concluído</span>
            </div>
          </div>
        </article>
      </section>
    </div>
  );
}
