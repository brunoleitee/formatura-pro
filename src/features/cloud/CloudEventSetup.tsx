import { Bot, FolderSearch, Sparkles } from 'lucide-react';
import type { CloudEventDraft } from './types';
import styles from '../../views/CloudView.module.css';

type CloudEventSetupProps = {
  draft: CloudEventDraft;
  creating: boolean;
  analyzing: boolean;
  onCreateCatalog: () => void;
  onSelectReferences: () => void;
  onAnalyze: () => void;
};

export function CloudEventSetup({
  draft,
  creating,
  analyzing,
  onCreateCatalog,
  onSelectReferences,
  onAnalyze,
}: CloudEventSetupProps) {
  return (
    <section className={styles.eventSetup}>
      <div>
        <span className={styles.kicker}>Pasta selecionada</span>
        <h2>Preparar evento cloud</h2>
      </div>

      <div className={styles.eventDetails}>
        <div>
          <span>Nome do evento</span>
          <strong>{draft.name}</strong>
        </div>
        <div>
          <span>Origem</span>
          <strong>Google Drive</strong>
        </div>
        <div>
          <span>Pasta selecionada</span>
          <strong>{draft.sourceFolderName}</strong>
        </div>
        <div>
          <span>Arquivos encontrados</span>
          <strong>{draft.totalFiles ?? 'Aguardando leitura'}</strong>
        </div>
      </div>

      {draft.referencesFolderName && (
        <div className={styles.referenceLine}>
          Referências: <strong>{draft.referencesFolderName}</strong>
        </div>
      )}

      <div className={styles.actionRow}>
        <button type="button" className={styles.primaryButton} onClick={onCreateCatalog} disabled={creating}>
          <Sparkles size={16} />
          {creating ? 'Criando...' : 'Criar catálogo cloud'}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onSelectReferences}>
          <FolderSearch size={16} />
          Selecionar pasta de referências
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onAnalyze} disabled={analyzing}>
          <Bot size={16} />
          {analyzing ? 'Preparando...' : 'Analisar com IA'}
        </button>
      </div>
    </section>
  );
}
