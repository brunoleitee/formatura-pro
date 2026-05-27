import type { Photo, Person, Stats, ScanStatus, ReviewClustersPageResponse, CatalogFolderStats, ReviewClusterSummary } from '../services/api';

const DEFAULT_PHOTOS_GOAL = 8;

function pct(a: number, b: number): number {
  return b > 0 ? Math.round((a / b) * 100) : 0;
}

export interface DashboardData {
  totalPhotos: number;
  identifiedPhotos: number;
  pendingPhotos: number;
  completionPct: number;
  studentCount: number;
  unknownClusters: number;
  blurredCount: number;
  duplicateCount: number;
  noIdCount: number;
  refsWithoutMatch: number | null;
  classCoverage: { className: string; students: number; photos: number; avgPhotos: number; goalPct: number }[];
  topStudents: { key: string; name: string; photos: number; goal: number; percent: number; complete: boolean }[];
  aiSuggestions: { label: string; sublabel: string; percent?: number; tone?: string; thumbUrl?: string; clusterId: string }[];
  chartBuckets: number[];
  chartMax: number;
  totalPeople: number;
  totalOccurrences: number;
  unknownCount: number;
}

export function computeDashboardMetrics(
  people: Person[],
  photos: Photo[],
  stats: Stats | null,
  clusters: ReviewClustersPageResponse | null,
  scanStatus: ScanStatus | null,
): DashboardData | null {
  if (!stats && !people.length) return null;

  const totalPhotos = stats?.total_photos ?? photos.length;
  const identifiedPhotos = stats?.named_people ?? 0;
  const pendingPhotos = Math.max(totalPhotos - identifiedPhotos, 0);
  const completionPct = pct(identifiedPhotos, totalPhotos);
  const studentCount = people.length;
  const unknownClusters = clusters?.total ?? stats?.unknown_count ?? 0;

  const blurredCount = stats?.blurred_photos ?? 0;
  const duplicateCount = scanStatus?.duplicate_count ?? 0;
  const noIdCount = stats?.no_id_faces ?? 0;
  const refsWithoutMatch = stats?.refs_without_match ?? null;

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

  const aiSuggestions = (clusters?.clusters ?? []).slice(0, 4).map((cl: ReviewClusterSummary) => {
    const rep = cl.representative;
    let thumbUrl: string | undefined;
    if (rep?.path && rep.box) {
      thumbUrl = `/api/thumb?path=${encodeURIComponent(rep.path)}&x1=${rep.box[0]}&y1=${rep.box[1]}&x2=${rep.box[2]}&y2=${rep.box[3]}&size=120&expand=0.15&q=75`;
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
}
