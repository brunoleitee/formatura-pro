import { memo } from 'react';

export const PhotoGridSkeleton = memo(function PhotoGridSkeleton() {
  const cards = Array.from({ length: 12 }, (_, i) => i);

  return (
    <div className="photo-grid-skeleton" style={{ padding: '4px' }}>
      {cards.map(id => (
        <div key={id} className="photo-skeleton-card">
          <div className="photo-skeleton-img" />
          <div className="photo-skeleton-info">
            <div className="photo-skeleton-title" />
            <div className="photo-skeleton-meta" />
          </div>
        </div>
      ))}
    </div>
  );
});
