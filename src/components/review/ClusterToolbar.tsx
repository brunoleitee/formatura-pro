import { Image as ImageIcon, User, Maximize2, Sparkles, ChevronDown, ScanFace, GitCompare } from 'lucide-react';
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
  bestStudentName?: string | null;
  bestStudentSim?: number | null;
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

export default function ClusterToolbar({
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
  bestStudentName,
  bestStudentSim,
  onCompare,
}: ClusterToolbarProps) {
  // Ranges por modo: FOTO controla largura da coluna (240-380px), ROSTO controla tamanho do quadrado (130-280px)
  const zoomMin = viewMode === 'photo' ? 180 : 120;
  const zoomMax = viewMode === 'photo' ? 380 : 280;
  const zoomStep = viewMode === 'photo' ? 20 : 10;
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
        <span className={styles.sortPrefix}>Ordenar por:</span>
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

      {/* Selecionar melhores */}
      <button className={styles.btnSelectBest} onClick={onSelectBest}>
        <Sparkles size={13} />
        Selecionar melhores
      </button>

      {/* Separador */}
      <div className={styles.sep} />

      {/* Toggle Foto/Rosto */}
      <div className={styles.viewToggle}>
        <button
          className={`${styles.viewBtn} ${viewMode === 'photo' ? styles.viewBtnActive : ''}`}
          onClick={() => onViewMode('photo')}
          title="Foto inteira"
          type="button"
        >
          <ImageIcon size={14} />
          <span>Foto</span>
        </button>
        <button
          className={`${styles.viewBtn} ${viewMode === 'face' ? styles.viewBtnActive : ''}`}
          onClick={() => onViewMode('face')}
          title="Apenas rosto"
          type="button"
        >
          <ScanFace size={14} />
          <span>Rosto</span>
        </button>
      </div>

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

      {/* Fullscreen icon */}
      <button className={styles.iconBtn} title="Tela cheia">
        <Maximize2 size={14} />
      </button>

      {/* Compare button */}
      {(() => {
        const isValid = bestStudentName && bestStudentName !== 'null' && bestStudentName !== 'unknown';
        console.log('[COMPARE BUTTON]\nstudent=' + bestStudentName + '\nsimilarity=' + bestStudentSim + '\nenabled=' + !!isValid);
        
        return (
          <button 
            className={styles.compareBtn} 
            title={isValid ? `Comparar com ${bestStudentName} — ${Math.round((bestStudentSim || 0) * 100)}%` : 'Comparar'}
            onClick={isValid ? onCompare : undefined}
            disabled={!isValid}
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
}
