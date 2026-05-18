import { useEffect, useRef } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import styles from './ConfirmModal.module.css';

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  open,
  title,
  message,
  confirmText = 'Confirmar',
  cancelText = 'Cancelar',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => cancelBtnRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-message"
      >
        <button className={styles.closeBtn} onClick={onCancel} aria-label="Fechar">
          <X size={14} />
        </button>

        <div className={styles.iconWrap} aria-hidden="true">
          <AlertTriangle size={18} />
        </div>

        <h2 id="confirm-modal-title" className={styles.title}>
          {title}
        </h2>
        <p id="confirm-modal-message" className={styles.message}>
          {message}
        </p>

        <div className={styles.actions}>
          <button ref={cancelBtnRef} className={styles.cancelBtn} onClick={onCancel}>
            {cancelText}
          </button>
          <button className={styles.confirmBtn} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </section>
    </div>
  );
}
