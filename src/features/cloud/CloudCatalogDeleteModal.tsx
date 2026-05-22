import { Trash2, X } from 'lucide-react';
import { useState } from 'react';
import styles from './CloudWorkflowPanel.module.css';

type DeleteScope = 'recent' | 'catalog_cache' | 'all';

type CloudCatalogDeleteModalProps = {
  catalogName: string;
  scope: DeleteScope;
  onScopeChange: (scope: DeleteScope) => void;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
};

const scopeCopy: Record<DeleteScope, { title: string; description: string }> = {
  recent: {
    title: 'Somente catálogo recente',
    description: 'Remove da lista recente, mas mantém a pasta física e a IA do evento.',
  },
  catalog_cache: {
    title: 'Catálogo + cache',
    description: 'Remove o catálogo recente e limpa caches/embeddings gerados localmente.',
  },
  all: {
    title: 'Excluir tudo permanentemente',
    description: 'Apaga a pasta do catálogo inteiro do disco local.',
  },
};

export function CloudCatalogDeleteModal({
  catalogName,
  scope,
  onScopeChange,
  onConfirm,
  onCancel,
}: CloudCatalogDeleteModalProps) {
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.modalOverlay}>
      <div className={styles.modalContent}>
        <div className={styles.modalHeader}>
          <h2>Excluir catálogo cloud</h2>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onCancel}
            disabled={busy}
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        <div className={styles.modalForm}>
          <div className={styles.formGroup}>
            <label>Catálogo</label>
            <div className={styles.formField}>
              <span className={styles.fieldValue}>{catalogName}</span>
            </div>
            <small>Escolha o nível de exclusão com cuidado.</small>
          </div>

          <div className={styles.modalOptionList}>
            {(Object.keys(scopeCopy) as DeleteScope[]).map(item => (
              <label key={item} className={styles.modalOption} data-selected={scope === item}>
                <input
                  type="radio"
                  name="cloud-delete-scope"
                  checked={scope === item}
                  onChange={() => onScopeChange(item)}
                />
                <div>
                  <strong>{scopeCopy[item].title}</strong>
                  <small>{scopeCopy[item].description}</small>
                </div>
              </label>
            ))}
          </div>

          <div className={styles.modalActions}>
            <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>
              Cancelar
            </button>
            <button type="button" className={styles.dangerButton} onClick={() => void handleConfirm()} disabled={busy}>
              <Trash2 size={15} />
              {busy ? 'Excluindo...' : 'Excluir'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
