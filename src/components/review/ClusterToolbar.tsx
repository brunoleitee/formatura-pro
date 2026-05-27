import { memo } from 'react';
import { Image as ImageIcon, ChevronDown, ScanFace, GitCompare } from 'lucide-react';
import styles from './ClusterToolbar.module.css';

export type FilterOption = 'all' | 'best' | 'sharp';
export type SortOption = 'best_match' | 'sharpest' | 'rowid';
export type ViewMode = 'photo' | 'face';

interface ClusterToolbarProps {
  filter: FilterOption;
  sort: SortOption;
  viewMode: ViewMode;
  zoom: number;
  totalVisible: number;
  totalAll: number;
  onFilter: (f: FilterOption) => void;
  onSort: (s: SortOption) => void;
  onViewMode: (v: ViewMode) => void;
  onZoom: (z: number) => void;
  onSelectBest: () => void;
  compareStudent?: string | null;
  compareSimilarity?: number | null;
  onCompare?: () => void;
}

const FILTER_LABELS: Record<FilterOption, string> = {
  all: 'Todas as fotos',
  best: 'Melhores matches',
  sharp: 'Apenas nítidas',
};

const SORT_LABELS: Record<SortOption, string> = {
  best_match: 'Melhor match',
  sharpest: 'Mais nítida',
  rowid: 'Original',
};

const ClusterToolbar = memo(function ClusterToolbar({
  filter,
  sort,
  viewMode,
  zoom,
  totalVisible,
  totalAll,
  onFilter,
  onSort,
  onViewMode,
  onZoom,
  onSelectBest,
  compareStudent,
  compareSimilarity,
  onCompare,
}: ClusterToolbarProps) {
  // Ranges por modo: FOTO controla largura da coluna (240-380px), ROSTO controla tamanho do quadrado (130-280px)
  const zoomMin = viewMode === 'photo' ? 180 : 120;
  const zoomMax = viewMode === 'photo' ? 380 : 280;
  const zoomStep = viewMode === 'photo' ? 20 : 10;
  const nextViewMode = viewMode === 'photo' ? 'face' : 'photo';
  return (
    <div className={styles.toolbar}>
      {/* Filtro */}
      <div className={styles.selectWrap}>
        <select
          className={styles.select}
          value={filter}
          onChange={e => onFilter(e.target.value as FilterOption)}
        >
          {(Object.entries(FILTER_LABELS) as [FilterOption, string][]).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <ChevronDown size={12} className={styles.selectIcon} />
      </div>

      {/* Ordenação */}
      <div className={styles.selectWrap}>
        <select
          className={`${styles.select} ${styles.selectSort}`}
          value={sort}
          onChange={e => onSort(e.target.value as SortOption)}
        >
          {(Object.entries(SORT_LABELS) as [SortOption, string][]).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <ChevronDown size={12} className={styles.selectIcon} />
      </div>

      {/* Toggle Foto/Rosto */}
      <button
        className={styles.viewToggleSingle}
        onClick={() => onViewMode(nextViewMode)}
        title={viewMode === 'photo' ? 'Alternar para rosto' : 'Alternar para foto inteira'}
        type="button"
      >
        {viewMode === 'photo' ? <ImageIcon size={14} /> : <ScanFace size={14} />}
        <span>{viewMode === 'photo' ? 'Foto' : 'Rosto'}</span>
      </button>

      {/* Zoom slider */}
      <div className={styles.zoomWrap}>
        <input
          type="range"
          min={zoomMin}
          max={zoomMax}
          step={zoomStep}
          value={Math.max(zoomMin, Math.min(zoomMax, zoom))}
          onChange={e => onZoom(Number(e.target.value))}
          className={styles.zoomSlider}
          title={`Altura: ${zoom}px`}
        />
      </div>

      {/* Compare button */}
      {(() => {
        const sim = compareSimilarity;
        const simValid = sim != null && isFinite(sim) && !isNaN(sim);
        const compareEnabled = !!compareStudent && simValid && sim >= 0.30;
        const simLabel = simValid ? `${Math.round(sim * 100)}%` : '--%';
        return (
          <button
            className={styles.compareBtn}
            title={compareEnabled ? `Comparar com ${compareStudent} — ${simLabel}` : 'Comparar'}
            onClick={compareEnabled ? onCompare : undefined}
            disabled={!compareEnabled}
          >
            <GitCompare size={14} />
            <span>Comparar</span>
          </button>
        );
      })()}

      {/* Counter (push to right) */}
      <div className={styles.counter}>
        Mostrando {totalVisible} de {totalAll} fotos
      </div>
    </div>
  );
});

export default ClusterToolbar;
