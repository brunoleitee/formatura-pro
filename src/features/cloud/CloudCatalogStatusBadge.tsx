import type { CloudEventDraft } from './types';
import styles from './CloudWorkflowPanel.module.css';

type CloudCatalogStatusBadgeProps = {
  status: CloudEventDraft['status'];
};

const statusLabels: Record<CloudEventDraft['status'], string> = {
  draft: 'Draft',
  indexed: 'Indexado',
  processing: 'Processando',
  ready: 'Pronto',
};

export function CloudCatalogStatusBadge({ status }: CloudCatalogStatusBadgeProps) {
  return (
    <span className={styles.statusBadge} data-status={status}>
      <span aria-hidden="true" />
      {statusLabels[status]}
    </span>
  );
}
