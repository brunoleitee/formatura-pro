import { useState, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
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
  index,
  isSelected,
  onClick,
}: {
  cluster: RichCluster;
  index: number;
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

  return (
    <motion.button
      className={`${styles.item} ${isSelected ? styles.itemActive : ''}`}
      onClick={onClick}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.5), duration: 0.25 }}
      whileHover={{ x: 3 }}
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
          {(cluster.total_photos ?? cluster.photo_count ?? cluster.face_count)} foto{(cluster.total_photos ?? cluster.photo_count ?? cluster.face_count) !== 1 ? 's' : ''}
          <span className={styles.dot}>·</span>
          <span className={styles.confidence}>{pct}%</span>
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
    </motion.button>
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
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all');
  const hasGraduationAnalysis = clusters.some((cluster) =>
    Boolean(
      cluster.has_gown ||
      cluster.has_diploma ||
      cluster.has_sash ||
      cluster.has_cap ||
      (cluster.graduation_tags?.length ?? 0) > 0
    )
  );

  const filteredByPriority = clusters.filter((cluster) => {
    const tags = cluster.graduation_tags ?? [];
    switch (priorityFilter) {
      case 'gown':
        return tags.includes('beca') || Boolean(cluster.has_gown);
      case 'diploma':
        return tags.includes('canudo') || tags.includes('diploma') || Boolean(cluster.has_diploma);
      case 'sash':
        return tags.includes('faixa') || Boolean(cluster.has_sash);
      case 'cap':
        return tags.includes('capelo') || Boolean(cluster.has_cap);
      case 'high_priority':
        return (cluster.priority_score ?? 0) >= 25;
      default:
        return true;
    }
  });

  const visible = search.trim()
    ? filteredByPriority.filter((cluster, i) =>
        `grupo ${i + 1}`.includes(search.toLowerCase()) ||
        String(cluster.face_count).includes(search) ||
        (cluster.graduation_tags ?? []).some(tag => tag.includes(search.toLowerCase()))
      )
    : filteredByPriority;
  const showMissingGraduationAnalysis =
    !search &&
    visible.length === 0 &&
    (priorityFilter === 'gown' || priorityFilter === 'diploma' || priorityFilter === 'sash' || priorityFilter === 'cap') &&
    !graduationAnalysisRan &&
    !hasGraduationAnalysis;
  const showNoMatchingGraduationClusters =
    !search &&
    visible.length === 0 &&
    (priorityFilter === 'gown' || priorityFilter === 'diploma' || priorityFilter === 'sash' || priorityFilter === 'cap') &&
    (graduationAnalysisRan || hasGraduationAnalysis);

  return (
    <aside className={styles.sidebar}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.headerTitle}>
            <span className={styles.titleText}>Descobertos pela IA</span>
            <span className={styles.titleCount}>
              {loading ? '...' : clusters.length}
            </span>
          </div>
          <button
            className={styles.refreshBtn}
            onClick={onRefresh}
            title="Recarregar clusters"
          >
            <RefreshCw size={13} className={loading ? styles.spin : ''} />
          </button>
        </div>
        <p className={styles.headerSub}>
          {loading ? 'Calculando...' : clusters.length === 0
            ? 'Nenhum grupo pendente'
            : `${clusters.length} grupo${clusters.length !== 1 ? 's' : ''} aguardando identificação`}
        </p>
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
          <button className={styles.searchClear} onClick={() => setSearch('')}>
            <X size={11} />
          </button>
        )}
      </div>

      <div className={styles.filterWrap}>
        <select
          className={styles.filterSelect}
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value as PriorityFilter)}
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
        ) : visible.length === 0 ? (
          <div className={styles.listState}>
            <span>
              {search
                ? 'Sem resultados'
                : showMissingGraduationAnalysis
                ? 'A IA ainda não analisou beca/canudo/faixa neste catálogo.'
                : showNoMatchingGraduationClusters
                ? 'Nenhum cluster com beca/canudo/faixa encontrado.'
                : 'Tudo identificado!'}
            </span>
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {visible.map((cluster, i) => (
              <ClusterItem
                key={cluster.cluster_id}
                cluster={cluster}
                index={i}
                isSelected={cluster.cluster_id === selectedId}
                onClick={() => onSelect(cluster)}
              />
            ))}
          </AnimatePresence>
        )}
      </div>
    </aside>
  );
}
