import styles from '../../views/ScannerWorkspace.module.css';

export default function CircularGauge({ pct }: { pct: number }) {
  const radius = 38;
  const circ = 2 * Math.PI * radius;
  const safePct = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  const offset = circ - (safePct / 100) * circ;
  return (
    <div className={styles.gaugeContainer}>
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="#1a1c23" strokeWidth="5" />
        <circle 
          cx="50" cy="50" r={radius} fill="none" stroke="#3b82f6" strokeWidth="5" 
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          transform="rotate(-90 50 50)"
          style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />
      </svg>
      <div className={styles.gaugeText}>
        <span className={styles.gaugePct}>{Math.round(pct)}%</span>
      </div>
    </div>
  );
}
