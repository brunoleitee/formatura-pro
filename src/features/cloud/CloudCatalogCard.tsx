import { CalendarClock, Cloud, Images } from 'lucide-react';
import { CloudCatalogStatusBadge } from './CloudCatalogStatusBadge';
import type { CloudCatalog } from './types';
import styles from './CloudWorkflowPanel.module.css';

type CloudCatalogCardProps = {
  catalog: CloudCatalog;
  onOpen: (catalog: CloudCatalog) => void;
};

function formatDate(value?: string) {
  if (!value) return 'Sem abertura';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sem abertura';
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const modeLabel: Record<CloudCatalog['mode'], string> = {
  catalog: 'Catálogo',
  face: 'Reconhecimento',
  full: 'Scanner completo',
};

export function CloudCatalogCard({ catalog, onOpen }: CloudCatalogCardProps) {
  const isCloud = catalog.source === 'cloud' || catalog.provider === 'google_drive';
  const statusDate = catalog.lastOpenedAt || catalog.updatedAt || catalog.lastSync;

  return (
    <button
      type="button"
      className={styles.catalogCard}
      onClick={() => onOpen(catalog)}
      title={catalog.name}
    >
      <div className={styles.catalogCardHeader}>
        <strong>{catalog.name}</strong>
        <CloudCatalogStatusBadge status={catalog.status} />
      </div>
      <div className={styles.catalogCardMeta}>
        {isCloud && (
          <span className={styles.cloudBadge}>
            <Cloud size={12} />
            Cloud
          </span>
        )}
        <span title="Google Drive">Google Drive</span>
        <span title={`${catalog.totalFiles} fotos`}>
          <Images size={13} />
          {catalog.totalFiles}
        </span>
        <span title={modeLabel[catalog.mode]}>{modeLabel[catalog.mode]}</span>
      </div>
      <div className={styles.catalogCardFooter}>
        <CalendarClock size={13} />
        <span title={formatDate(statusDate)}>
          {formatDate(statusDate)}
        </span>
      </div>
    </button>
  );
}
