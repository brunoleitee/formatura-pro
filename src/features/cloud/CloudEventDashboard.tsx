import { Bot, Download, FolderOpen, Play, ShieldCheck } from 'lucide-react';
import { CloudStatusBadge } from './CloudStatusBadge';
import type { CloudCatalogAIStatus, CloudEventDraft } from './types';
import styles from './CloudWorkflowPanel.module.css';

type CloudEventDashboardProps = {
  draft: CloudEventDraft;
  aiStatus?: CloudCatalogAIStatus | null;
  onProcessAi: () => void | Promise<void>;
  onOpenCatalogRoot: (path?: string) => void | Promise<void>;
  onOpenCatalogFolder: (path?: string) => void | Promise<void>;
  onReopenLastState: () => void | Promise<void>;
};

const modeLabel: Record<CloudEventDraft['mode'], string> = {
  catalog: 'Catálogo',
  face: 'Reconhecimento',
  full: 'Scanner completo',
};

export function CloudEventDashboard({
  draft,
  aiStatus,
  onProcessAi,
  onOpenCatalogRoot,
  onOpenCatalogFolder,
  onReopenLastState,
}: CloudEventDashboardProps) {
  const stats = [
    { label: 'Total fotos', value: draft.totalFiles },
    { label: 'Referências', value: draft.references.length },
    { label: 'Subpastas', value: draft.totalSubfolders ?? draft.subfolderCount ?? 0 },
    { label: 'Faces detectadas', value: aiStatus?.facesCount ?? 0 },
    { label: 'Embeddings gerados', value: aiStatus?.embeddingsCount ?? 0 },
    { label: 'Clusters', value: aiStatus?.clustersCount ?? 0 },
    { label: 'Revisão pendente', value: aiStatus?.reviewPendingCount ?? 0 },
    { label: 'Provider', value: 'Google Drive' },
    { label: 'Modo', value: modeLabel[draft.mode] },
    { label: 'Cache cloud', value: draft.cacheEnabled === false ? 'desligado' : `${draft.cacheSize ?? 0} MB` },
    { label: 'Último processamento IA', value: aiStatus?.lastProcessedAt ? new Date(aiStatus.lastProcessedAt).toLocaleDateString('pt-BR') : 'pendente' },
  ];

  const handleOpenCatalogFolder = () => {
    if (!draft.catalogPath) return;
    void onOpenCatalogFolder(`${draft.catalogPath}/Catalogo`);
  };

  const handleOpenCatalogRoot = () => {
    if (!draft.catalogPath) return;
    void onOpenCatalogRoot(draft.catalogPath);
  };

  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.kicker}>Catálogo cloud criado</span>
          <h2>{draft.name}</h2>
        </div>
        <CloudStatusBadge status={draft.status} />
      </div>

      <div className={styles.dashboardGrid}>
        {stats.map(stat => (
          <div className={styles.statTile} key={stat.label}>
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
          </div>
        ))}
      </div>

      <div className={styles.pathStack}>
        <div className={styles.pathBlock}>
          <span>Caminho do catálogo</span>
          <strong title={draft.catalogPath || 'Pasta do catálogo ainda não criada'}>
            {draft.catalogPath || 'Pasta do catálogo ainda não criada'}
          </strong>
        </div>
        <div className={styles.pathBlock}>
          <span>Cache local do evento</span>
          <strong title={draft.cachePath || 'Cache local ainda não criado'}>
            {draft.cachePath || 'Cache local ainda não criado'}
          </strong>
        </div>
      </div>

      <p className={styles.mutedLine}>
        IA do catálogo: {aiStatus?.status === 'ready' ? 'pronta' : aiStatus?.status === 'processing' ? 'processando' : 'aguardando'}
        {aiStatus?.message ? ` · ${aiStatus.message}` : ''}
      </p>

      <div className={styles.actionRow}>
        <button type="button" className={styles.primaryButton} onClick={handleOpenCatalogRoot} disabled={!draft.catalogPath}>
          <ShieldCheck size={15} />
          Abrir catálogo
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onProcessAi}>
          <Play size={15} />
          Processar IA do catálogo
        </button>
        <button type="button" className={styles.secondaryButton} onClick={handleOpenCatalogRoot} disabled={!draft.catalogPath}>
          <FolderOpen size={15} />
          Abrir pasta
        </button>
        <button type="button" className={styles.secondaryButton} onClick={handleOpenCatalogFolder} disabled={!draft.catalogPath}>
          <Download size={15} />
          Abrir catálogo interno
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onReopenLastState} disabled={!draft.id}>
          <ShieldCheck size={15} />
          Reabrir último estado
        </button>
      </div>

      <p className={styles.mutedFooter}>
        <Bot size={14} />
        Pronto para ligar a IA cloud em uma próxima etapa.
      </p>
    </section>
  );
}
