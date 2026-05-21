import { X } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { CloudEventDraft, CloudCatalogMode } from './types';
import styles from './CloudWorkflowPanel.module.css';

type CloudCatalogCreateModalProps = {
  draft: CloudEventDraft;
  parentFolderName?: string;
  creating: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
};

export function CloudCatalogCreateModal({
  draft,
  parentFolderName,
  creating,
  onConfirm,
  onCancel,
}: CloudCatalogCreateModalProps) {
  const [name, setName] = useState('');

  useEffect(() => {
    setName(parentFolderName || draft.sourceFolderName || draft.name);
  }, [parentFolderName, draft.sourceFolderName, draft.name]);

  const modeLabel: Record<CloudCatalogMode, string> = {
    catalog: 'Catálogo',
    face: 'Reconhecimento',
    full: 'Scanner completo',
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onConfirm(name.trim());
    }
  };

  return (
    <div className={styles.modalOverlay}>
      <div className={styles.modalContent}>
        <div className={styles.modalHeader}>
          <h2>Criar catálogo cloud</h2>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onCancel}
            disabled={creating}
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className={styles.modalForm}>
          <div className={styles.formGroup}>
            <label htmlFor="catalog-name">Nome do catálogo</label>
            <input
              id="catalog-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Nome do catálogo"
              disabled={creating}
              autoFocus
              className={styles.formInput}
            />
            <small>Será exibido na lista de catálogos recentes</small>
          </div>

          <div className={styles.formGrid}>
            <div className={styles.formField}>
              <span className={styles.fieldLabel}>Pasta de origem</span>
              <div className={styles.fieldValue}>{draft.sourceFolderName}</div>
            </div>

            <div className={styles.formField}>
              <span className={styles.fieldLabel}>Provider</span>
              <div className={styles.fieldValue}>Google Drive</div>
            </div>

            <div className={styles.formField}>
              <span className={styles.fieldLabel}>Modo do catálogo</span>
              <div className={styles.fieldValue}>{modeLabel[draft.mode]}</div>
            </div>

            <div className={styles.formField}>
              <span className={styles.fieldLabel}>Total de fotos</span>
              <div className={styles.fieldValue}>{draft.totalFiles.toLocaleString('pt-BR')}</div>
            </div>
          </div>

          {draft.references.length > 0 && (
            <div className={styles.formGroup}>
              <span className={styles.fieldLabel}>Referências detectadas</span>
              <ul className={styles.referenceList}>
                {draft.references.map((ref, idx) => (
                  <li key={idx}>{ref}</li>
                ))}
              </ul>
            </div>
          )}

          <div className={styles.modalActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onCancel}
              disabled={creating}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className={styles.primaryButton}
              disabled={!name.trim() || creating}
            >
              {creating ? 'Criando...' : 'Criar catálogo'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
