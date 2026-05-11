import { useMemo, useState, memo } from 'react';
import { RefreshCw, Search, X } from 'lucide-react';
import type { RichCluster } from '../../services/api';
import { faceThumb } from './FaceCard';
import styles from './ReviewSidebar.module.css';

type PriorityFilter = 'all' | 'gown' | 'diploma' | 'sash' | 'cap' | 'high_priority';

interface ReviewSidebarProps {
  clusters: RichCluster[];
  loading: boolean;
  selectedId: string | null;
  graduationAnalysisRan?: boolean;
  onSelect: (cluster: RichCluster) => void;
  onRefresh: () => void;
}

const ClusterItem = memo(function ClusterItem({
  cluster,
  isSelected,
  onClick,
}: {
  cluster: RichCluster;
  isSelected: boolean;
  onClick: () => void;
}) {
  const rep = cluster.representative;
  const pct = Math.round(cluster.cohesion_score * 100);
  const tags = cluster.graduation_tags ?? [];
  const badgeLabels = [
    { id: 'ia', label: 'IA', variant: 'ia' as const },
    ...(tags.includes('beca') ? [{ id: 'beca', label: 'Beca', variant: 'tag' as const }] : []),
    ...(tags.includes('canudo') ? [{ id: 'canudo', label: 'Canudo', variant: 'tag' as const }] : []),
    ...(tags.includes('faixa') ? [{ id: 'faixa', label: 'Faixa', variant: 'tag' as const }] : []),
    ...(tags.includes('capelo') ? [{ id: 'capelo', label: 'Capelo', variant: 'tag' as const }] : []),
  ];
  const photoCount = cluster.total_photos ?? cluster.photo_count ?? cluster.face_count;
  const photoCountLabel = `${photoCount} foto${photoCount !== 1 ? 's' : ''}`;
  const confidenceLabel = `${pct}%`;

  return (
    <button
      className={`${styles.item} ${isSelected ? styles.itemActive : ''}`}
      onClick={onClick}
      type="button"
      translate="no"
    >
      <div className={styles.avatar}>
        {rep ? (
          <img
            src={faceThumb(rep.path, rep.box, 100)}
            alt=""
            loading="lazy"
            className={styles.avatarImg}
            onError={e => {
              const el = e.currentTarget as HTMLImageElement;
              el.style.display = 'none';
              const next = el.nextElementSibling as HTMLElement | null;
              if (next) next.style.display = 'flex';
            }}
          />
        ) : null}
        <div className={styles.avatarFallback} style={{ display: rep ? 'none' : 'flex' }}>?</div>
      </div>

      <div className={styles.itemInfo}>
        <span className={styles.itemName}>Pessoa desconhecida</span>
        <span className={styles.itemMeta}>
          <span>{photoCountLabel}</span>
          <span className={styles.dot}>·</span>
          <span className={styles.confidence}>{confidenceLabel}</span>
        </span>
        <span className={styles.badgeRow}>
          {badgeLabels.map((badge) => (
            <span
              key={badge.id}
              className={badge.variant === 'ia' ? styles.iaBadge : styles.tagBadge}
            >
              {badge.label}
            </span>
          ))}
        </span>
      </div>
    </button>
  );
});

export default function ReviewSidebar({
  clusters,
  loading,
  selectedId,
  graduationAnalysisRan = false,
  onSelect,
  onRefresh,
}: ReviewSidebarProps) {
  const [search, setSearch] = useState('');
  const [graduationFilter, setGraduationFilter] = useState<PriorityFilter>('all');
  const titleCountLabel = loading ? '...' : String(clusters.length);
  const headerSubLabel = loading ? 'Calculando...' : clusters.length === 0
    ? 'Nenhum grupo pendente'
    : `${clusters.length} grupo${clusters.length !== 1 ? 's' : ''} aguardando identificação`;
  const hasGraduationAnalysis = clusters.some((cluster) =>
    Boolean(
      cluster.has_gown ||
      cluster.has_diploma ||
      cluster.has_sash ||
      cluster.has_cap ||
      (cluster.graduation_tags?.length ?? 0) > 0
    )
  );

  const filteredClusters = useMemo(() => {
    if (graduationFilter === 'all') return clusters;

    return clusters.filter((cluster) => {
      const tags = Array.isArray(cluster.graduation_tags)
        ? cluster.graduation_tags
        : [];

      if (graduationFilter === 'gown') {
        return cluster.has_gown === true || tags.includes('beca');
      }

      if (graduationFilter === 'diploma') {
        return cluster.has_diploma === true || tags.includes('canudo') || tags.includes('diploma');
      }

      if (graduationFilter === 'sash') {
        return cluster.has_sash === true || tags.includes('faixa');
      }

      if (graduationFilter === 'cap') {
        return cluster.has_cap === true || tags.includes('capelo');
      }

      if (graduationFilter === 'high_priority') {
        return (cluster.priority_score ?? 0) >= 25;
      }

      return true;
    });
  }, [clusters, graduationFilter]);

  const visibleClusters = search.trim()
    ? filteredClusters.filter((cluster, i) =>
        `grupo ${i + 1}`.includes(search.toLowerCase()) ||
        String(cluster.face_count).includes(search) ||
        (cluster.graduation_tags ?? []).some(tag => tag.includes(search.toLowerCase()))
      )
    : filteredClusters;

  console.log('[graduation-filter]', {
    filter: graduationFilter,
    totalOriginal: clusters.length,
    totalFiltered: filteredClusters.length,
    sample: clusters.slice(0, 5).map(c => ({
      id: c.cluster_id,
      tags: c.graduation_tags,
      has_gown: c.has_gown,
      has_diploma: c.has_diploma,
      has_sash: c.has_sash,
      has_cap: c.has_cap,
    })),
  });

  const showMissingGraduationAnalysis =
    !search &&
    visibleClusters.length === 0 &&
    (graduationFilter === 'gown' || graduationFilter === 'diploma' || graduationFilter === 'sash' || graduationFilter === 'cap') &&
    !graduationAnalysisRan &&
    !hasGraduationAnalysis;
  const showNoMatchingGraduationClusters =
    !search &&
    visibleClusters.length === 0 &&
    (graduationFilter === 'gown' || graduationFilter === 'diploma' || graduationFilter === 'sash' || graduationFilter === 'cap') &&
    (graduationAnalysisRan || hasGraduationAnalysis);

  return (
    <aside className={`${styles.sidebar} notranslate`} translate="no">
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.headerTitle}>
            <span className={styles.titleText}>Descobertos pela IA</span>
            <span className={styles.titleCount}>{titleCountLabel}</span>
          </div>
          <button
            className={styles.refreshBtn}
            onClick={onRefresh}
            title="Recarregar clusters"
            type="button"
          >
            <RefreshCw size={13} className={loading ? styles.spin : ''} />
          </button>
        </div>
        <p className={styles.headerSub}><span>{headerSubLabel}</span></p>
      </div>

      {/* Divider */}
      <div className={styles.divider} />

      {/* Search */}
      <div className={styles.searchWrap}>
        <Search size={13} className={styles.searchIcon} />
        <input
          className={styles.searchInput}
          placeholder="Filtrar grupos..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <button className={styles.searchClear} onClick={() => setSearch('')} type="button">
            <X size={11} />
          </button>
        )}
      </div>

      <div className={styles.filterWrap}>
        <select
          className={styles.filterSelect}
          value={graduationFilter}
          onChange={(e) => setGraduationFilter(e.target.value as PriorityFilter)}
        >
          <option value="all">Todos</option>
          <option value="gown">Com beca</option>
          <option value="diploma">Com canudo</option>
          <option value="sash">Com faixa</option>
          <option value="cap">Com capelo</option>
          <option value="high_priority">Alta prioridade IA</option>
        </select>
      </div>

      {/* Cluster list */}
      <div className={styles.list}>
        {loading && clusters.length === 0 ? (
          <div className={styles.listState}>
            <RefreshCw size={18} className={styles.spin} style={{ opacity: 0.4 }} />
            <span>Calculando...</span>
          </div>
        ) : visibleClusters.length === 0 ? (
          <div className={styles.listState}>
            <span>
              {search
                ? 'Sem resultados'
                : showMissingGraduationAnalysis
                ? 'A IA ainda não analisou beca/canudo/faixa neste catálogo.'
                : showNoMatchingGraduationClusters
                ? 'Nenhum cluster com este item encontrado.'
                : 'Tudo identificado!'}
            </span>
          </div>
        ) : (
          <>
            {visibleClusters.map((cluster) => (
              <ClusterItem
                key={cluster.cluster_id}
                cluster={cluster}
                isSelected={cluster.cluster_id === selectedId}
                onClick={() => onSelect(cluster)}
              />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
