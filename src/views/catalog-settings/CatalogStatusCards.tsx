import styles from '../CatalogSettingsView.module.css';

export function CatalogStatusCards() {
  const stats = [
    { label: 'Pastas ativas', value: '2', dot: styles.statusDotBlue },
    { label: 'Total de fotos', value: '0', dot: styles.statusDotGreen },
    { label: 'Fotos reconhecidas', value: '0', dot: styles.statusDotPurple },
    { label: 'Fotos novas', value: '0', dot: styles.statusDotAmber },
    { label: 'Último scan', value: '—', dot: styles.statusDotBlue },
  ];

  return (
    <div className={styles.statusSection}>
      {stats.map((s, i) => (
        <div key={i} className={styles.statusRow}>
          <span className={styles.statusLabel}>
            <span className={`${styles.statusDot} ${s.dot}`} />
            {s.label}
          </span>
          <span className={styles.statusValue}>{s.value}</span>
        </div>
      ))}
    </div>
  );
}
