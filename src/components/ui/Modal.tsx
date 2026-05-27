import { useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import { useKeyDown } from '../../hooks/useKeyDown';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import styles from './Modal.module.css';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

export default function Modal({ open, onClose, title, children, actions, icon, size = 'md' }: ModalProps) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useBodyScrollLock(open);
  useKeyDown('Escape', (e) => { e.preventDefault(); onClose(); });

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => closeBtnRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  return (
    <div className={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className={`${styles.modal} ${styles[size]}`} role="dialog" aria-modal="true" aria-label={title}>
        <button ref={closeBtnRef} className={styles.closeBtn} onClick={onClose} aria-label="Fechar">
          <X size={16} />
        </button>
        {icon && <div className={styles.iconWrap}>{icon}</div>}
        {title && <h2 className={styles.title}>{title}</h2>}
        <div className={styles.body}>{children}</div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </section>
    </div>
  );
}
