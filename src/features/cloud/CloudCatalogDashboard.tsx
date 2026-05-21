import { Bot, Download, Play, ShieldCheck } from 'lucide-react';
import type { CloudEventDraft } from './types';
import styles from '../../views/CloudView.module.css';

type CloudCatalogDashboardProps = {
  draft: CloudEventDraft;
  onAnalyze: () => void;
};

export function CloudCatalogDashboard({ draft, onAnalyze }: CloudCatalogDashboardProps) {
  const total = draft.totalFiles ?? 0;
  const stats = [
    { label: 'Total de fotos', value: total },
    { label: 'Referências', value: draft.referencesFolderId ? 1 : 0 },
    { label: 'Processadas', value: draft.status === 'ready' ? total : 0 },
    { label: 'Reconhecidas', value: 0 },
    { label: 'Revisão', value: 0 },
    { label: 'Cache', value: draft.status === 'indexed' ? 'metadata' : 'pronto' },
  ];

  return (
    <section className={styles.dashboardPanel}>
      <div className={styles.dashboardHeader}>
        <div>
          <span className={styles.kicker}>Catálogo criado</span>
          <h2>{draft.name}</h2>
        </div>
        <span className={styles.statusPill}>{draft.status}</span>
      </div>

      <div className={styles.statsGrid}>
        {stats.map(stat => (
          <div className={styles.statCard} key={stat.label}>
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
          </div>
        ))}
      </div>

      <div className={styles.actionRow}>
        <button type="button" className={styles.primaryButton}>
          <ShieldCheck size={16} />
          Abrir revisão IA
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onAnalyze}>
          <Play size={16} />
          Processar agora
        </button>
        <button type="button" className={styles.secondaryButton}>
          <Download size={16} />
          Exportar/Organizar
        </button>
      </div>

      <p className={styles.dashboardNote}>
        <Bot size={14} />
        Reconhecimento facial e organização no Drive ficam para a próxima etapa.
      </p>
    </section>
  );
}
