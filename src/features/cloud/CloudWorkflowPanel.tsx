import { Bot, CheckCircle2, Cloud, FolderOpen, Sparkles } from 'lucide-react';
import { CloudCatalogMode } from './CloudCatalogMode';
import { CloudReferenceDetection } from './CloudReferenceDetection';
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

export function CloudWorkflowPanel({
  draft,
  loading,
  creating,
  progress,
  analyzing,
  catalogReady,
  onModeChange,
  onCreateCatalog,
  onChangeReferences,
  onAnalyze,
}: CloudWorkflowPanelProps) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.kicker}>Preparação guiada</span>
          <h2>Preparar evento cloud</h2>
        </div>
      </div>

      <div className={styles.stepList}>
        <article className={styles.step}>
          <span className={styles.stepNumber}>1</span>
          <div className={styles.stepBody}>
            <h3>Evento selecionado</h3>
            <div className={styles.eventSummary}>
              <span>
                <FolderOpen size={14} />
                {draft.sourceFolderName}
              </span>
              <strong>{loading ? 'Contando fotos...' : `${draft.totalFiles} fotos`}</strong>
              <small>{draft.subfolderCount ?? 0} subpastas</small>
            </div>
          </div>
        </article>

        <article className={styles.step}>
          <span className={styles.stepNumber}>2</span>
          <div className={styles.stepBody}>
            <h3>Referências detectadas</h3>
            <CloudReferenceDetection
              references={draft.references}
              loading={loading}
              onChangeReferences={onChangeReferences}
            />
          </div>
        </article>

        <article className={styles.step}>
          <span className={styles.stepNumber}>3</span>
          <div className={styles.stepBody}>
            <h3>Modo do catálogo</h3>
            <CloudCatalogMode value={draft.mode} onChange={onModeChange} disabled={creating || analyzing} />
          </div>
        </article>

        <article className={styles.step}>
          <span className={styles.stepNumber}>4</span>
          <div className={styles.stepBody}>
            <h3>Criar catálogo cloud</h3>
            {creating && progress && (
              <div className={styles.catalogProgress}>
                <div className={styles.progressRing} style={{ '--progress': `${progress.percent}%` } as React.CSSProperties}>
                  <span>{progress.percent}%</span>
                </div>
                <div className={styles.progressCopy}>
                  <strong>{progress.label}</strong>
                  <span>{progress.percent < 100 ? 'Indexando...' : 'Indexado'}</span>
                </div>
              </div>
            )}
            <button type="button" className={styles.primaryButton} onClick={onCreateCatalog} disabled={loading || creating}>
              <Sparkles size={15} />
              {creating ? 'Indexando...' : 'Criar catálogo cloud'}
            </button>
          </div>
        </article>

        <article className={styles.step}>
          <span className={styles.stepNumber}>5</span>
          <div className={styles.stepBody}>
            <h3>Analisar com IA</h3>
            <button type="button" className={styles.secondaryButton} onClick={onAnalyze} disabled={!catalogReady || loading || creating || analyzing}>
              <Bot size={15} />
              {analyzing ? 'Preparando...' : 'Analisar com IA'}
            </button>
          </div>
        </article>
      </div>

      <p className={styles.mutedFooter}>
        <CheckCircle2 size={14} />
        <Cloud size={14} />
        Estrutura preparada sem baixar fotos originais.
      </p>
    </section>
  );
}
