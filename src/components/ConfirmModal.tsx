import { useRef, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from './ui/Modal';
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
    const frame = requestAnimationFrame(() => cancelBtnRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <Modal open={open} onClose={onCancel} title={title} icon={<AlertTriangle size={18} />} size="sm">
      <p className={styles.message}>{message}</p>
      <div className={styles.actions}>
        <button ref={cancelBtnRef} className={styles.cancelBtn} onClick={onCancel}>
          {cancelText}
        </button>
        <button className={styles.confirmBtn} onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    </Modal>
  );
}
