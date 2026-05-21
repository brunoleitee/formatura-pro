import { CloudCatalogStatusBadge } from './CloudCatalogStatusBadge';
import type { CloudEventDraft } from './types';

type CloudStatusBadgeProps = {
  status: CloudEventDraft['status'];
};

export function CloudStatusBadge({ status }: CloudStatusBadgeProps) {
  return <CloudCatalogStatusBadge status={status} />;
}
