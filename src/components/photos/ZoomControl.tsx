import styles from './ZoomControl.module.css';

interface ZoomControlProps {
  zoom: number;
  onZoom: (z: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

export function ZoomControl({ zoom, onZoom, min = 120, max = 380, step = 20 }: ZoomControlProps) {
  return (
    <div className={styles.zoomWrap}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.max(min, Math.min(max, zoom))}
        onChange={e => onZoom(Number(e.target.value))}
        className={styles.zoomSlider}
        title={`Tamanho: ${zoom}px`}
      />
      <span className={styles.zoomLabel}>{zoom}</span>
    </div>
  );
}