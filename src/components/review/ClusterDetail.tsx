import { useState, useMemo, useCallback, useEffect, useRef, type CSSProperties } from 'react';
import type { AssignClusterResponse, RichCluster, RichClusterFace } from '../../services/api';
import { api } from '../../services/api';
// import { useDragSelection } from '../../hooks/useDragSelection';
import ClusterHero, { type ClusterHeroHandle } from './ClusterHero';
import ClusterStatsPanel from './ClusterStatsPanel';
import ClusterToolbar from './ClusterToolbar';
import CompareModal from './CompareModal';
import type { FilterOption, SortOption, ViewMode } from './ClusterToolbar';
import { PhotoCard } from './PhotoCard';
import { GraduationActions, type GraduationActionsHandle, type GraduationItem } from './GraduationActions';
import styles from './ClusterDetail.module.css';

const ZOOM_FACE_DEFAULT = 170;
const ZOOM_PHOTO_DEFAULT = 240;

interface ClusterDetailProps {
  cluster: RichCluster;
  catalog: string;
  onAssigned: (payload: AssignClusterResponse) => void;
  onSkip: () => void;
  onClusterUpdate: (next: RichCluster) => void;
  onOpenPhoto?: (path: string) => void;
  assignmentState?: {
    clusterId: string;
    studentName: string;
    className: string;
    status: string;
  } | null;
}

function filterFaces(faces: RichClusterFace[], filter: FilterOption): RichClusterFace[] {
  switch (filter) {
    case 'best': return faces.filter(f => f.is_representative || f.blur_status === 'sharp');
    case 'sharp': return faces.filter(f => f.blur_status === 'sharp');
    default: return faces;
  }
}

function sortFaces(faces: RichClusterFace[], sort: SortOption): RichClusterFace[] {
  const copy = [...faces];
  switch (sort) {
    case 'best_match':
      return copy.sort((a, b) => (b.is_representative ? 1 : 0) - (a.is_representative ? 1 : 0));
    case 'sharpest': {
      const order = { sharp: 0, attention: 1, blurry: 2 };
      return copy.sort((a, b) =>
        (order[a.blur_status as keyof typeof order] ?? 3) -
        (order[b.blur_status as keyof typeof order] ?? 3)
      );
    }
    default: return copy.sort((a, b) => a.rowid - b.rowid);
  }
}

export default function ClusterDetail({
  cluster,
  catalog,
  onAssigned,
  onSkip,
  onClusterUpdate,
  onOpenPhoto,
  assignmentState = null,
}: ClusterDetailProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<FilterOption>('all');
  const [sort, setSort] = useState<SortOption>('best_match');
  const [viewMode, setViewMode] = useState<ViewMode>('face');
  const [zoom, setZoom] = useState(ZOOM_FACE_DEFAULT);
  const [collapsed, setCollapsed] = useState(false);
  const [lastSelectedRowId, setLastSelectedRowId] = useState<number | null>(null);
  const [isCompareOpen, setIsCompareOpen] = useState(false);
  const [rejectedName, setRejectedName] = useState<string | null>(null);
  const [matchedLabel, setMatchedLabel] = useState<string | null>(null);
  const heroRef = useRef<ClusterHeroHandle>(null);
  const graduationRef = useRef<GraduationActionsHandle>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Reset ao mudar cluster
  useEffect(() => {
    setSelected(new Set());
    setFilter('all');
    setSort('best_match');
    setLastSelectedRowId(null);
    setMatchedLabel(null);
  }, [cluster.cluster_id]);

  // Resetar selection state ao mudar view mode, filter, ou sort (opcional, mas recomendado)
  useEffect(() => {
    setLastSelectedRowId(null);
  }, [filter, sort]);

  // Resetar zoom ao trocar modo: cada modo tem seu default próprio
  useEffect(() => {
    setZoom(viewMode === 'photo' ? ZOOM_PHOTO_DEFAULT : ZOOM_FACE_DEFAULT);
  }, [viewMode]);

  useEffect(() => {
    function isTypingInField(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (isTypingInField(e.target)) return;
      if (e.key === 'Escape') {
        setSelected(new Set());
        setLastSelectedRowId(null);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const map: Record<string, GraduationItem> = { b: 'gown', c: 'diploma', f: 'sash', k: 'cap' };
      if (map[k]) {
        e.preventDefault();
        graduationRef.current?.toggle(map[k]);
        return;
      }
      if (e.key === 'Delete') {
        e.preventDefault();
        onSkip();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        heroRef.current?.startIdentify();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSkip]);

  const visibleFaces = useMemo(() =>
    sortFaces(filterFaces(cluster.faces, filter), sort),
    [cluster.faces, filter, sort]
  );

  const visibleRowIds = useMemo(
    () => visibleFaces.map(f => f.rowid),
    [visibleFaces]
  );

  const handlePhotoSelect = useCallback((rowid: number, event: React.MouseEvent) => {
    setSelected(prev => {
      const next = new Set(prev);

      if (event.shiftKey && lastSelectedRowId != null) {
        const start = visibleRowIds.indexOf(lastSelectedRowId);
        const end = visibleRowIds.indexOf(rowid);

        if (start >= 0 && end >= 0) {
          const [from, to] = start < end ? [start, end] : [end, start];

          for (const id of visibleRowIds.slice(from, to + 1)) {
            next.add(id);
          }

          return next;
        }
      }

      if (event.ctrlKey || event.metaKey) {
        if (next.has(rowid)) next.delete(rowid);
        else next.add(rowid);

        return next;
      }

      if (next.has(rowid) && next.size === 1) {
        next.clear();
      } else {
        next.clear();
        next.add(rowid);
      }

      return next;
    });

    setLastSelectedRowId(rowid);
  }, [lastSelectedRowId, visibleRowIds]);

  const handleSelectBest = useCallback(() => {
    const best = cluster.faces
      .filter(f => f.is_representative || f.blur_status === 'sharp')
      .map(f => f.rowid);
    setSelected(new Set(best.length > 0 ? best : cluster.faces.map(f => f.rowid)));
    setLastSelectedRowId(null);
  }, [cluster.faces]);

  // Zoom controlado pelo slider. Ajuste adaptativo mínimo para preencher espaço.
  const gridZoom = useMemo(() => {
    const count = visibleFaces.length;
    if (count <= 2) return Math.min(zoom + 40, viewMode === 'face' ? 280 : 420);
    if (count <= 4) return Math.min(zoom + 20, viewMode === 'face' ? 280 : 420);
    return zoom;
  }, [visibleFaces.length, zoom, viewMode]);
  const thumbSize = gridZoom >= 240 ? 600 : 400;
  const photoImgH = Math.round(gridZoom * 0.85);

  const cleanName = (n: any) => (!n || n === 'null' || n === 'unknown') ? null : n;

  const compareStudent =
    cleanName(cluster.suggested_student) ||
    cleanName(cluster.best_student_debug);

  const compareSimilarity =
    compareStudent === cleanName(cluster.suggested_student)
      ? (cluster.suggested_similarity ?? 0)
      : (cluster.best_similarity_debug ?? 0);

  // Buscar label amigável (nome real) se houver um melhor match
  useEffect(() => {
    if (compareStudent && !matchedLabel) {
      api.getStudentMatchPreview(catalog, cluster.cluster_id, compareStudent)
        .then(data => {
          if (data.matched_student_label) {
            setMatchedLabel(data.matched_student_label);
          }
        })
        .catch(() => {
          // Fallback silencioso para o ID original
        });
    }
  }, [compareStudent, catalog, cluster.cluster_id]);

  const displayCompareName = matchedLabel || compareStudent;



  return (
    <div className={`${styles.root} ${assignmentState?.clusterId === cluster.cluster_id ? styles.rootAssigned : ''}`} key={cluster.cluster_id}>
      {/* ── Header compacto ── */}
      <div className={`${styles.topSection} ${collapsed ? styles.topSectionCollapsed : ''}`}>
        <ClusterHero
          ref={heroRef}
          cluster={cluster}
          catalog={catalog}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed(v => !v)}
          assignmentState={assignmentState}
          onAssigned={onAssigned}
          onSkip={onSkip}
        />
        {!collapsed && (
          <ClusterStatsPanel
            cluster={cluster}
            selectedCount={selected.size}
          />
        )}
      </div>

      {/* ── Linha pequena: badges + Corrigir itens ── */}
      <div className={styles.graduationActionsWrap}>
        <GraduationActions
          ref={graduationRef}
          cluster={cluster}
          catalog={catalog}
          onUpdate={onClusterUpdate}
        />
      </div>

      {/* ── Toolbar compacta ── */}
      <ClusterToolbar
        filter={filter}
        sort={sort}
        viewMode={viewMode}
        zoom={zoom}
        totalVisible={visibleFaces.length}
        totalAll={cluster.faces.length}
        onFilter={setFilter}
        onSort={setSort}
        onViewMode={setViewMode}
        onZoom={setZoom}
        onSelectBest={handleSelectBest}
        compareStudent={displayCompareName}
        compareSimilarity={compareSimilarity}
        onCompare={() => setIsCompareOpen(true)}
      />

      {/* ── Grid de fotos (prioridade visual) ── */}
      <div className={styles.gridScroll}>
        <div
          ref={gridRef}
          className={`${styles.gridSelectionHost} ${viewMode === 'photo' ? styles.clusterGridPhoto : styles.clusterGridFace}`}
          style={{
            '--grid-item-size': `${gridZoom}px`,
            '--photo-img-h': `${photoImgH}px`,
          } as CSSProperties}
        >
          {visibleFaces.map(face => (
          <PhotoCard
              key={face.rowid}
              face={face}
              selected={selected.has(face.rowid)}
              onToggle={(e) => handlePhotoSelect(face.rowid, e)}
              onOpen={onOpenPhoto ? (nextFace) => onOpenPhoto(nextFace.path) : undefined}
              clickMode={onOpenPhoto ? 'open' : 'select'}
              thumbSize={thumbSize}
              viewMode={viewMode}
            />
          ))}
        </div>

        {visibleFaces.length === 0 && (
          <div className={styles.emptyFilter}>
            <span>Nenhuma foto com o filtro atual.</span>
          </div>
        )}
      </div>

      {isCompareOpen && compareStudent && (
        <CompareModal
          cluster={cluster}
          catalog={catalog}
          bestName={compareStudent}
          bestSim={compareSimilarity}
          onConfirm={async (name) => {
            setIsCompareOpen(false);
            if (onAssigned) {
              try {
                const result = await api.assignCluster(catalog, {
                  cluster_id: cluster.cluster_id,
                  aluno_id: name,
                  nome_formando: name,
                });
                onAssigned(result);
              } catch (err) {
                console.error('Erro ao confirmar aluno no modal:', err);
              }
            }
          }}
          onClose={() => setIsCompareOpen(false)}
          onReject={(name) => {
            setRejectedName(name);
            setIsCompareOpen(false);
            if (cluster.suggested_student === name) {
              cluster.suggested_student = null;
              cluster.suggested_similarity = null;
            }
            if (cluster.best_student_debug === name) {
              cluster.best_student_debug = null;
              cluster.best_similarity_debug = null;
            }
          }}
        />
      )}

    </div>
  );
}
