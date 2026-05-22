import { FolderOpen, Images, Library, ListChecks, Plus } from 'lucide-react';
import type { CloudCatalogMode as CloudCatalogModeValue, CloudEventDraft } from './types';
import styles from './CloudWorkflowPanel.module.css';

type CloudWorkflowPanelProps = {
  draft: CloudEventDraft;
  loading: boolean;
  creating: boolean;
  progress?: {
    percent: number;
    label: string;
  } | null;
  analyzing: boolean;
  catalogReady: boolean;
  onModeChange: (mode: CloudCatalogModeValue) => void;
  onCreateCatalog: () => void;
  onChangeReferences: () => void;
  onAnalyze: () => void;
};

function formatCount(value: number) {
  return new Intl.NumberFormat('pt-BR').format(value || 0);
}

export function CloudWorkflowPanel({
  draft,
  loading,
  creating,
  progress,
  onCreateCatalog,
}: CloudWorkflowPanelProps) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.kicker}>Pasta pronta para catálogo</span>
          <h2>{draft.sourceFolderName}</h2>
        </div>
      </div>

      <div className={styles.readyList}>
        <div className={styles.readyRow}>
          <FolderOpen size={15} />
          <span>Pasta atual</span>
          <strong>{draft.sourceFolderName}</strong>
        </div>
        <div className={styles.readyRow}>
          <Library size={15} />
          <span>Evento base sugerido</span>
          <strong>{draft.eventRootFolderName || draft.sourceFolderName}</strong>
        </div>
        <div className={styles.readyRow}>
          <Images size={15} />
          <span>Fotos encontradas</span>
          <strong>{loading ? 'Contando...' : formatCount(draft.totalFiles)}</strong>
        </div>
        <div className={styles.readyRow}>
          <ListChecks size={15} />
          <span>Referências detectadas</span>
          <strong>{formatCount(draft.references.length)}</strong>
        </div>
      </div>

      {draft.references.length > 0 && (
        <ul className={styles.referenceList}>
          {draft.references.map(reference => (
            <li key={reference}>{reference}</li>
          ))}
        </ul>
      )}

      {creating && progress && (
        <div className={styles.inlineProgress}>
          <strong>{progress.label}</strong>
          <span>{progress.percent}%</span>
        </div>
      )}

      <button type="button" className={styles.primaryButton} onClick={onCreateCatalog} disabled={loading || creating}>
        <Plus size={15} />
        {creating ? 'Criando...' : 'Criar catálogo cloud'}
      </button>
    </section>
  );
}
