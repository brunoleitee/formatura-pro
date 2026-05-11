import type { PhotoFilter } from '../../hooks/usePhotoFilters';

interface PhotoFiltersProps {
  filter: PhotoFilter;
  onFilterChange: (filter: PhotoFilter) => void;
}

const TABS: { key: PhotoFilter; label: string }[] = [
  { key: 'all', label: 'Todas' },
  { key: 'mapped', label: 'Identificadas' },
  { key: 'unmapped', label: 'Não Mapeadas' },
];

export function PhotoFilters({ filter, onFilterChange }: PhotoFiltersProps) {
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
    </div>
  );
}
