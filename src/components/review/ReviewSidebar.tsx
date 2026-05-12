import { useMemo, useState, memo } from 'react';
import { RefreshCw, Search, X } from 'lucide-react';
import type { RichCluster } from '../../services/api';
import { faceThumb } from './FaceCard';
import styles from './ReviewSidebar.module.css';

type PriorityFilter = 'all' | 'gown' | 'diploma' | 'sash' | 'cap' | 'high_priority';

const CONF_CONFIRMED = 0.92;
const CONF_POSSIBLE = 0.70;

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
  function gownBadge() {
    const conf = cluster.gown_confidence ?? (cluster.has_gown ? 1 : 0);
    if (conf >= CONF_CONFIRMED) return { id: 'beca', label: 'Beca', variant: 'tag' as const };
    if (conf >= CONF_POSSIBLE) return { id: 'beca_possible', label: 'Possível beca', variant: 'tagMuted' as const };
    return null;
  }
  function diplomaBadge() {
    const conf = cluster.diploma_confidence ?? (cluster.has_diploma ? 1 : 0);
    if (conf >= CONF_CONFIRMED) return { id: 'canudo', label: 'Canudo', variant: 'tag' as const };
    if (conf >= CONF_POSSIBLE) return { id: 'canudo_possible', label: 'Possível canudo', variant: 'tagMuted' as const };
    return null;
  }
  function sashBadge() {
    const conf = cluster.sash_confidence ?? (cluster.has_sash ? 1 : 0);
    if (conf >= CONF_CONFIRMED) return { id: 'faixa', label: 'Faixa', variant: 'tag' as const };
    if (conf >= CONF_POSSIBLE) return { id: 'faixa_possible', label: 'Possível faixa', variant: 'tagMuted' as const };
    return null;
  }
  function capBadge() {
    const conf = cluster.cap_confidence ?? (cluster.has_cap ? 1 : 0);
    if (conf >= CONF_CONFIRMED) return { id: 'capelo', label: 'Capelo', variant: 'tag' as const };
    if (conf >= CONF_POSSIBLE) return { id: 'capelo_possible', label: 'Possível capelo', variant: 'tagMuted' as const };
    return null;
  }
  const badgeLabels = [
    { id: 'ia', label: 'IA', variant: 'ia' as const },
    ...[gownBadge(), diplomaBadge(), sashBadge(), capBadge()].filter(Boolean) as { id: string; label: string; variant: 'tag' | 'tagMuted' }[],
  ];
  const photoCount = cluster.total_photos ?? cluster.photo_count ?? cluster.face_count;
  const photoCountLabel = `${photoCount} foto${photoCount !== 1 ? 's' : ''}`;
  const confidenceLabel = `${pct}%`;

  return (
    <button
      className={`${styles.item} ${isSelected ? styles.itemActive : ''}`}
      onClick={onClick}
      type="button"
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
              className={
                badge.variant === 'ia' ? styles.iaBadge :
                badge.variant === 'tagMuted' ? styles.tagBadgeMuted :
                styles.tagBadge
              }
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
      (cluster.gown_confidence ?? (cluster.has_gown ? 1 : 0)) >= CONF_POSSIBLE ||
      (cluster.diploma_confidence ?? (cluster.has_diploma ? 1 : 0)) >= CONF_POSSIBLE ||
      (cluster.sash_confidence ?? (cluster.has_sash ? 1 : 0)) >= CONF_POSSIBLE ||
      (cluster.cap_confidence ?? (cluster.has_cap ? 1 : 0)) >= CONF_POSSIBLE ||
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
        const conf = cluster.gown_confidence ?? (cluster.has_gown ? 1 : 0);
        return conf >= CONF_POSSIBLE || tags.includes('beca');
      }

      if (graduationFilter === 'diploma') {
        const conf = cluster.diploma_confidence ?? (cluster.has_diploma ? 1 : 0);
        return conf >= CONF_POSSIBLE || tags.includes('canudo') || tags.includes('diploma');
      }

      if (graduationFilter === 'sash') {
        const conf = cluster.sash_confidence ?? (cluster.has_sash ? 1 : 0);
        return conf >= CONF_POSSIBLE || tags.includes('faixa');
      }

      if (graduationFilter === 'cap') {
        const conf = cluster.cap_confidence ?? (cluster.has_cap ? 1 : 0);
        return conf >= CONF_POSSIBLE || tags.includes('capelo');
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
    <aside className={`${styles.sidebar}`}>
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
