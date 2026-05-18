import type { CatalogFolderStats } from '../../services/api';
import styles from '../CatalogSettingsView.module.css';

interface Props {
  stats: CatalogFolderStats | null;
}

export function CatalogStatusCards({ stats }: Props) {
  const items = [
    { label: 'Pastas ativas', value: stats?.activeFolders ?? '--', dot: styles.statusDotBlue },
    { label: 'Total de fotos', value: stats?.totalPhotos ?? '--', dot: styles.statusDotGreen },
    { label: 'Fotos reconhecidas', value: stats?.recognizedPhotos ?? '--', dot: styles.statusDotPurple },
    { label: 'Fotos novas', value: stats?.newPhotos ?? '--', dot: styles.statusDotAmber },
    { label: 'Faces detectadas', value: stats?.totalFaces ?? '--', dot: styles.statusDotPink },
    { label: 'Fotos com faces', value: stats?.photosWithFaces ?? '--', dot: styles.statusDotCyan },
    { label: 'Pessoas conhecidas', value: stats?.knownPersons ?? '--', dot: styles.statusDotOrange },
    { label: 'Último scan', value: stats?.lastScanAt ? new Date(stats.lastScanAt * 1000).toLocaleDateString() : '--', dot: styles.statusDotBlue },
  ];

  return (
    <div className={styles.statusSection}>
      {items.map((s, i) => (
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
