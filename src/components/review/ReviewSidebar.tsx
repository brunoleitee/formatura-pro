import { useState, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, Search, X } from 'lucide-react';
import type { RichCluster } from '../../services/api';
import { faceThumb } from './FaceCard';
import styles from './ReviewSidebar.module.css';

interface ReviewSidebarProps {
  clusters: RichCluster[];
  loading: boolean;
  selectedId: string | null;
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
          {cluster.face_count} foto{cluster.face_count !== 1 ? 's' : ''}
          <span className={styles.dot}>·</span>
          <span className={styles.confidence}>{pct}%</span>
        </span>
      </div>

      <div className={styles.iaBadge}>IA</div>
    </motion.button>
  );
});

export default function ReviewSidebar({
  clusters,
  loading,
  selectedId,
  onSelect,
  onRefresh,
}: ReviewSidebarProps) {
  const [search, setSearch] = useState('');

  const visible = search.trim()
    ? clusters.filter((_, i) =>
        `grupo ${i + 1}`.includes(search.toLowerCase()) ||
        String(clusters[i]?.face_count).includes(search)
      )
    : clusters;

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

      {/* Cluster list */}
      <div className={styles.list}>
        {loading && clusters.length === 0 ? (
          <div className={styles.listState}>
            <RefreshCw size={18} className={styles.spin} style={{ opacity: 0.4 }} />
            <span>Calculando...</span>
          </div>
        ) : visible.length === 0 ? (
          <div className={styles.listState}>
            <span>{search ? 'Sem resultados' : 'Tudo identificado!'}</span>
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
