import { useState, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import type { RichCluster, RichClusterFace } from '../../services/api';
import ClusterHero from './ClusterHero';
import ClusterStatsPanel from './ClusterStatsPanel';
import ClusterToolbar from './ClusterToolbar';
import type { FilterOption, SortOption, ViewMode } from './ClusterToolbar';
import { PhotoCard } from './PhotoCard';
import styles from './ClusterDetail.module.css';

interface ClusterDetailProps {
  cluster: RichCluster;
  catalog: string;
  onAssigned: (clusterId: string) => void;
  onSkip: () => void;
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
}: ClusterDetailProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<FilterOption>('all');
  const [sort, setSort] = useState<SortOption>('best_match');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [zoom, setZoom] = useState(200);

  // Reset ao mudar cluster
  useState(() => {
    setSelected(new Set());
    setFilter('all');
    setSort('best_match');
  });

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

  const thumbSize = zoom > 220 ? 600 : 400;

  return (
    <motion.div
      className={styles.root}
      key={cluster.cluster_id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
    >
      {/* ── Seção superior: hero + stats ── */}
      <div className={styles.topSection}>
        <ClusterHero
          cluster={cluster}
          catalog={catalog}
          onAssigned={onAssigned}
          onSkip={onSkip}
        />
        <ClusterStatsPanel
          cluster={cluster}
          selectedCount={selected.size}
        />
      </div>

      {/* ── Toolbar ── */}
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

      {/* ── Grid de fotos ── */}
      <div className={styles.gridScroll}>
        <div
          className={styles.grid}
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(${zoom}px, 1fr))`,
          }}
        >
          {visibleFaces.map(face => (
            <PhotoCard
              key={face.rowid}
              face={face}
              selected={selected.has(face.rowid)}
              onToggle={() => toggleSelect(face.rowid)}
              thumbSize={thumbSize}
            />
          ))}
        </div>

        {visibleFaces.length === 0 && (
          <div className={styles.emptyFilter}>
            Nenhuma foto com o filtro atual.
          </div>
        )}
      </div>
    </motion.div>
  );
}
