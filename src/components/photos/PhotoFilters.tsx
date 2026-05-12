import type { PhotoFilter } from '../../hooks/usePhotoFilters';

interface PhotoFiltersProps {
  filter: PhotoFilter;
  onFilterChange: (filter: PhotoFilter) => void;
  hideDiscarded?: boolean;
  onHideDiscardedChange?: (hide: boolean) => void;
}

const TABS: { key: PhotoFilter; label: string }[] = [
  { key: 'all', label: 'Todas' },
  { key: 'mapped', label: 'Identificadas' },
  { key: 'unmapped', label: 'Não Mapeadas' },
];

export function PhotoFilters({ filter, onFilterChange, hideDiscarded = false, onHideDiscardedChange }: PhotoFiltersProps) {
  return (
    <div className="tab-group">
      {TABS.map((t) => (
        <button
          key={t.key}
          className={`tab-btn ${filter === t.key ? 'active' : ''}`}
          onClick={() => onFilterChange(t.key)}
        >
          {t.label}
        </button>
      ))}
      {onHideDiscardedChange && (
        <button
          className={`tab-btn ${hideDiscarded ? 'active' : ''}`}
          onClick={() => onHideDiscardedChange(!hideDiscarded)}
          title={hideDiscarded ? 'Mostrar descartadas' : 'Ocultar descartadas'}
        >
          {hideDiscarded ? '🔍 Ocultas' : '🚫 Ocultar'}
        </button>
      )}
    </div>
  );
}