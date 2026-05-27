import { memo } from 'react';
import { Eye, EyeOff } from 'lucide-react';
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

export const PhotoFilters = memo(function PhotoFilters({ filter, onFilterChange, hideDiscarded = false, onHideDiscardedChange }: PhotoFiltersProps) {
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
          title={hideDiscarded ? 'Mostrar fotos descartadas' : 'Ocultar fotos descartadas'}
          style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          {hideDiscarded ? <EyeOff size={15} /> : <Eye size={15} style={{ opacity: 0.8 }} />}
          <span>Ocultar Descartadas</span>
        </button>
      )}
    </div>
  );
});