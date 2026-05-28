import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, FileText, FolderOpen, Loader2 } from 'lucide-react';
import Modal from './ui/Modal';
import styles from './ExportFinishModal.module.css';

export interface ExportFinishModalProps {
  open: boolean;
  exportDir?: string;
  pdfPath?: string;
  onClose: () => void;
  onOpenPath: (path: string) => Promise<void> | void;
}

type CopyTarget = 'exportDir' | 'pdfPath' | null;
type OpenTarget = 'folder' | 'pdf' | null;

export default function ExportFinishModal({
  open,
  exportDir = '',
  pdfPath = '',
  onClose,
  onOpenPath,
}: ExportFinishModalProps) {
  const [copyTarget, setCopyTarget] = useState<CopyTarget>(null);
  const [openTarget, setOpenTarget] = useState<OpenTarget>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setError('');
      setCopyTarget(null);
      setOpenTarget(null);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open]);

  const handleCopy = async (value: string, target: CopyTarget) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyTarget(target);
      window.setTimeout(() => setCopyTarget(current => (current === target ? null : current)), 1200);
    } catch {
      setError('Nao foi possivel copiar o caminho.');
    }
  };

  const handleOpen = async (path: string, target: OpenTarget) => {
    if (!path) return;
    setError('');
    setOpenTarget(target);
    try {
      await onOpenPath(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nao foi possivel abrir o caminho selecionado.';
      setError(message);
    } finally {
      setOpenTarget(current => (current === target ? null : current));
    }
  };

  const hasPdf = Boolean(pdfPath);

  return (
    <Modal open={open} onClose={onClose} title="Exportação concluída" icon={<CheckCircle2 size={28} />}>
      <p className={styles.message}>Suas fotos foram exportadas com sucesso.</p>

      <div className={styles.pathGrid}>
        <section className={styles.pathCard}>
          <div className={styles.pathCardHeader}>
            <span className={styles.pathLabel}>Pasta exportada</span>
            <button
              type="button"
              className={styles.copyBtn}
              onClick={() => handleCopy(exportDir, 'exportDir')}
              disabled={!exportDir}
              aria-label="Copiar caminho da pasta exportada"
            >
              {copyTarget === 'exportDir' ? <CheckCircle2 size={14} /> : <Copy size={14} />}
              <span>{copyTarget === 'exportDir' ? 'Copiado' : 'Copiar'}</span>
            </button>
          </div>
          <div className={styles.pathValue} title={exportDir}>
            {exportDir || 'Caminho nao informado'}
          </div>
        </section>

        <section className={styles.pathCard}>
          <div className={styles.pathCardHeader}>
            <span className={styles.pathLabel}>PDF gerado</span>
            <button
              type="button"
              className={styles.copyBtn}
              onClick={() => handleCopy(pdfPath, 'pdfPath')}
              disabled={!pdfPath}
              aria-label="Copiar caminho do PDF"
            >
              {copyTarget === 'pdfPath' ? <CheckCircle2 size={14} /> : <Copy size={14} />}
              <span>{copyTarget === 'pdfPath' ? 'Copiado' : 'Copiar'}</span>
            </button>
          </div>
          <div className={styles.pathValue} title={pdfPath}>
            {pdfPath || 'PDF nao gerado'}
          </div>
        </section>
      </div>

      {error && (
        <div className={styles.errorBox} role="status" aria-live="polite">
          {error}
        </div>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={() => handleOpen(exportDir, 'folder')}
          disabled={!exportDir || openTarget !== null}
        >
          {openTarget === 'folder' ? <Loader2 size={16} className={styles.spin} /> : <FolderOpen size={16} />}
          <span>Abrir pasta</span>
        </button>

        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={() => handleOpen(pdfPath, 'pdf')}
          disabled={!hasPdf || openTarget !== null}
          title={hasPdf ? 'Abrir PDF' : 'PDF nao gerado'}
        >
          {openTarget === 'pdf' ? <Loader2 size={16} className={styles.spin} /> : <FileText size={16} />}
          <span>Abrir PDF</span>
        </button>

        <button
          type="button"
          className={styles.ghostBtn}
          onClick={onClose}
          disabled={openTarget !== null}
        >
          OK
        </button>
      </div>
    </Modal>
  );
}
