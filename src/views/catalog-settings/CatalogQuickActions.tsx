import { RotateCcw, Repeat, Brain } from 'lucide-react';
import styles from '../CatalogSettingsView.module.css';

export function CatalogQuickActions() {
  const actions = [
    { icon: <RotateCcw size={14} />, title: 'Escanear todas as pastas', desc: 'Reescanear todas as fotos do catálogo', color: 'Blue' as const },
    { icon: <Repeat size={14} />, title: 'Sincronizar catálogo', desc: 'Atualizar com novas fotos das pastas', color: 'Green' as const },
    { icon: <Brain size={14} />, title: 'Gerenciar eventos e subpastas', desc: 'Organizar pastas do evento', color: 'Purple' as const },
  ];

  const colorClass = (c: string) => {
    if (c === 'Blue') return styles.quickActionIconBlue;
    if (c === 'Green') return styles.quickActionIconGreen;
    return styles.quickActionIconPurple;
  };

  return (
    <div className={styles.quickActions}>
      {actions.map((a, i) => (
        <div key={i} className={styles.quickActionCard}>
          <div className={`${styles.quickActionIcon} ${colorClass(a.color)}`}>
            {a.icon}
          </div>
          <div className={styles.quickActionBody}>
            <div className={styles.quickActionTitle}>{a.title}</div>
            <div className={styles.quickActionDesc}>{a.desc}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
