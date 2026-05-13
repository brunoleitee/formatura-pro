import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Copy, FileText, FolderOpen, Loader2, X } from 'lucide-react';
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
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [copyTarget, setCopyTarget] = useState<CopyTarget>(null);
  const [openTarget, setOpenTarget] = useState<OpenTarget>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => closeBtnRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setError('');
      setCopyTarget(null);
      setOpenTarget(null);
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
    <AnimatePresence>
      {open && (
        <motion.div
          className={styles.overlay}
          role="presentation"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.section
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-finish-modal-title"
            aria-describedby="export-finish-modal-message"
            initial={{ opacity: 0, scale: 0.97, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            <button ref={closeBtnRef} className={styles.closeBtn} onClick={onClose} aria-label="Fechar">
              <X size={16} />
            </button>

            <div className={styles.iconWrap} aria-hidden="true">
              <CheckCircle2 size={28} />
            </div>

            <div className={styles.header}>
              <h2 id="export-finish-modal-title" className={styles.title}>
                Exportação concluída
              </h2>
              <p id="export-finish-modal-message" className={styles.message}>
                Suas fotos foram exportadas com sucesso.
              </p>
            </div>

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
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
