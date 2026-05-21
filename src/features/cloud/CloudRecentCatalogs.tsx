import { Clock3 } from 'lucide-react';
import { CloudCatalogCard } from './CloudCatalogCard';
import type { CloudCatalog } from './types';
import styles from './CloudWorkflowPanel.module.css';

type CloudRecentCatalogsProps = {
  catalogs: CloudCatalog[];
  loading?: boolean;
  onOpenCatalog: (catalog: CloudCatalog) => void;
};

export function CloudRecentCatalogs({ catalogs, loading = false, onOpenCatalog }: CloudRecentCatalogsProps) {
  return (
    <section className={styles.recentPanel}>
      <div className={styles.recentHeader}>
        <div>
          <span>
            <Clock3 size={15} />
            Catálogos recentes
          </span>
          <small>Workspace principal</small>
        </div>
        {loading && <small>Atualizando...</small>}
      </div>

      {catalogs.length > 0 ? (
        <div className={styles.recentGrid}>
          {catalogs.map(catalog => (
            <CloudCatalogCard key={catalog.id} catalog={catalog} onOpen={onOpenCatalog} />
          ))}
        </div>
      ) : (
        <p className={styles.mutedLine}>Nenhum catálogo cloud criado ainda.</p>
      )}
    </section>
  );
}
