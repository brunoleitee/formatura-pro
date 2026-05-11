import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { RichCluster, RichClusterFace } from '../../services/api';
import ClusterHero, { type ClusterHeroHandle } from './ClusterHero';
import ClusterStatsPanel from './ClusterStatsPanel';
import ClusterToolbar from './ClusterToolbar';
import type { FilterOption, SortOption, ViewMode } from './ClusterToolbar';
import { PhotoCard } from './PhotoCard';
import { GraduationActions, type GraduationActionsHandle, type GraduationItem } from './GraduationActions';
import styles from './ClusterDetail.module.css';

const ZOOM_DEFAULT = 200;

interface ClusterDetailProps {
  cluster: RichCluster;
  catalog: string;
  onAssigned: (clusterId: string) => void;
  onSkip: () => void;
  onClusterUpdate: (next: RichCluster) => void;
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
}: ClusterDetailProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<FilterOption>('all');
  const [sort, setSort] = useState<SortOption>('best_match');
  const [viewMode, setViewMode] = useState<ViewMode>('face');
  const [zoom, setZoom] = useState(ZOOM_DEFAULT); // altura dos cards em px
  const [collapsed, setCollapsed] = useState(false);
  const heroRef = useRef<ClusterHeroHandle>(null);
  const graduationRef = useRef<GraduationActionsHandle>(null);

  // Reset ao mudar cluster
  useEffect(() => {
    setSelected(new Set());
    setFilter('all');
    setSort('best_match');
  }, [cluster.cluster_id]);

  useEffect(() => {
    function isTypingInField(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (isTypingInField(e.target)) return;
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

  const toggleSelect = useCallback((rowid: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(rowid)) next.delete(rowid);
      else next.add(rowid);
      return next;
    });
  }, []);

  const handleSelectBest = useCallback(() => {
    const best = cluster.faces
      .filter(f => f.is_representative || f.blur_status === 'sharp')
      .map(f => f.rowid);
    setSelected(new Set(best.length > 0 ? best : cluster.faces.map(f => f.rowid)));
  }, [cluster.faces]);

  const cardHeight = zoom;
  const colWidth = Math.round(zoom * 1.33);
  const thumbSize = zoom > 200 ? 600 : 400;

  return (
    <div className={styles.root} key={cluster.cluster_id} translate="no">
      {/* ── Header compacto ── */}
      <div className={`${styles.topSection} ${collapsed ? styles.topSectionCollapsed : ''}`}>
        <ClusterHero
          ref={heroRef}
          cluster={cluster}
          catalog={catalog}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed(v => !v)}
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
      />

      {/* ── Grid de fotos (prioridade visual) ── */}
      <div className={styles.gridScroll}>
        <div
          className={styles.grid}
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(${colWidth}px, 1fr))`,
          }}
        >
          {visibleFaces.map(face => (
            <PhotoCard
              key={face.rowid}
              face={face}
              selected={selected.has(face.rowid)}
              onToggle={() => toggleSelect(face.rowid)}
              thumbSize={thumbSize}
              cardHeight={cardHeight}
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
    </div>
  );
}
