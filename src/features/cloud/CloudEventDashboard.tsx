import { Bot, Download, FolderOpen, Play, ShieldCheck } from 'lucide-react';
import { CloudCatalogStatusBadge } from './CloudCatalogStatusBadge';
import type { CloudEventDraft } from './types';
import styles from './CloudWorkflowPanel.module.css';

type CloudEventDashboardProps = {
  draft: CloudEventDraft;
  onAnalyze: () => void;
};

export function CloudEventDashboard({ draft, onAnalyze }: CloudEventDashboardProps) {
  const stats = [
    { label: 'Total fotos', value: draft.totalFiles },
    { label: 'Referências', value: draft.references.length },
    { label: 'Processadas', value: draft.status === 'ready' ? draft.totalFiles : 0 },
    { label: 'Reconhecidas', value: 0 },
    { label: 'Revisão', value: 0 },
    { label: 'Cache cloud', value: draft.cacheEnabled === false ? 'desligado' : `${draft.cacheSize ?? 0} MB` },
    { label: 'Última sincronização', value: draft.lastSync ? new Date(draft.lastSync).toLocaleDateString('pt-BR') : 'pendente' },
  ];

  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.kicker}>Catálogo cloud criado</span>
          <h2>{draft.name}</h2>
        </div>
        <CloudCatalogStatusBadge status={draft.status} />
      </div>

      <div className={styles.dashboardGrid}>
        {stats.map(stat => (
          <div className={styles.statTile} key={stat.label}>
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
          </div>
        ))}
      </div>

      <div className={styles.actionRow}>
        <button type="button" className={styles.primaryButton}>
          <ShieldCheck size={15} />
          Abrir revisão IA
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onAnalyze}>
          <Play size={15} />
          Processar agora
        </button>
        <button type="button" className={styles.secondaryButton}>
          <FolderOpen size={15} />
          Abrir catálogo
        </button>
        <button type="button" className={styles.secondaryButton}>
          <Download size={15} />
          Exportar/Organizar
        </button>
      </div>

      <p className={styles.mutedFooter}>
        <Bot size={14} />
        Pronto para ligar a IA cloud em uma próxima etapa.
      </p>
    </section>
  );
}
