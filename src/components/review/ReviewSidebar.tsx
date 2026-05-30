import { useMemo, useState, memo } from 'react';
import { RefreshCw, Search, Sparkles, X } from 'lucide-react';
import type { ReviewClusterSummary } from '../../services/api';
import { faceThumb } from './FaceCard';
import { formatSimilarity } from '../../utils/format';
import { getSuggestionInfo } from '../../utils/suggestionUtils';
import styles from './ReviewSidebar.module.css';

type SortOption = 'photo_count_desc' | 'name_asc' | 'name_desc';

interface ReviewSidebarProps {
  clusters: ReviewClusterSummary[];
  loading: boolean;
  loadingMore?: boolean;
  selectedId: string | null;
  total?: number;
  hasMore?: boolean;
  reviewReady?: boolean;
  graduationAnalysisRan?: boolean;
  onSelect: (clusterId: string) => void;
  onRefresh: () => void;
  onLoadMore?: () => void;
}

const ClusterItem = memo(function ClusterItem({
  cluster,
  isSelected,
  onClick,
  clusterId,
}: {
  cluster: ReviewClusterSummary;
  isSelected: boolean;
  onClick: (id: string) => void;
  clusterId: string;
}) {
  const rep = cluster.representative;
  const pct = Math.round(cluster.cohesion_score * 100);

  const badgeLabels: Array<{ id: string; label: string; variant: 'ia' | 'success' }> = [
    { id: 'ia', label: 'IA', variant: 'ia' as const },
    ...(cluster.status === 'identified' || cluster.status === 'confirmed'
      ? [{ id: 'identified', label: 'Identificado', variant: 'success' as const }]
      : []),
  ];
  const photoCount = cluster.total_photos ?? cluster.photo_count ?? cluster.face_count;
  const photoCountLabel = `${photoCount} foto${photoCount !== 1 ? 's' : ''}`;
  const confidenceLabel = `${pct}%`;
  const suggestionInfo = getSuggestionInfo(cluster);
  const matchSimilarity = suggestionInfo.tier === 'none' ? null : suggestionInfo.similarity;
  const matchTone =
    matchSimilarity == null ? 'none' :
    matchSimilarity >= 0.70 ? 'strong' :
    matchSimilarity > 0 ? 'partial' :
    'none';
  const matchToneClass =
    matchTone === 'strong' ? styles.itemMatchStrong :
    matchTone === 'partial' ? styles.itemMatchPartial :
    styles.itemMatchNone;

  return (
    <button
      className={`${styles.item} ${matchToneClass} ${isSelected ? styles.itemActive : ''}`}
      onClick={() => onClick(clusterId)}
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
        <span className={styles.itemName}>Pessoa {String(cluster.cluster_number).padStart(2, '0')}</span>
        <div className={styles.suggestionRow}>
            {(() => {
              const info = suggestionInfo;
              switch (info.tier) {
                case 'strong':
                  return <span className={styles.suggestionBadgeStrong} title={`${info.student} — ${formatSimilarity(info.similarity)}`}>{info.student} — {formatSimilarity(info.similarity)}</span>;
                case 'possible':
                  return <span className={styles.suggestionBadgePossible} title={`Possível: ${info.student} — ${formatSimilarity(info.similarity)}`}>Possível {info.student}</span>;
                case 'weak':
                  return <span className={styles.suggestionBadgeDebug} title={`Fraco: ${info.student} — ${formatSimilarity(info.similarity)}`}>Fraco: {info.student}</span>;
                case 'unknown':
                  return <span className={styles.suggestionBadgeUnknown} title={`Provável mesmo formando que grupo #${info.similarNumber} — ${formatSimilarity(info.similarity)}`}>Parece #<strong>{info.similarNumber}</strong> — {formatSimilarity(info.similarity)}</span>;
                default:
                  return <span className={styles.suggestionBadgeNone} title="Sem correspondência conhecida">Sem match</span>;
              }
            })()}
        </div>
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
                styles.successBadge
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
  loadingMore = false,
  selectedId,
  total = 0,
  hasMore = false,
  reviewReady = true,
  onSelect,
  onRefresh,
  onLoadMore,
}: ReviewSidebarProps) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('photo_count_desc');
  const loadedCount = clusters.length;
  const titleCountLabel = loading && loadedCount === 0 ? '...' : String(total || loadedCount);
  const headerSubLabel = loading ? 'Calculando...' : clusters.length === 0
    ? 'Nenhum grupo pendente'
    : `${total || loadedCount} grupo${(total || loadedCount) !== 1 ? 's' : ''} pendente${(total || loadedCount) !== 1 ? 's' : ''}`;

  const processedClusters = useMemo(() => {
    // 1. Filtrar por busca (local)
    let list = [...clusters];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((cluster) => {
        return (
          `pessoa ${String(cluster.cluster_number).padStart(2, '0')}`.includes(q) ||
          `grupo ${cluster.cluster_number}`.includes(q) ||
          String(cluster.face_count).includes(q) ||
          (cluster.graduation_tags ?? []).some(tag => tag.toLowerCase().includes(q))
        );
      });
    }

    // 2. Ordenar localmente
    if (sortBy === 'photo_count_desc') {
      list.sort((a, b) => {
        const cntA = a.total_photos ?? a.photo_count ?? a.face_count ?? 0;
        const cntB = b.total_photos ?? b.photo_count ?? b.face_count ?? 0;
        return cntB - cntA;
      });
    } else if (sortBy === 'name_asc') {
      list.sort((a, b) => a.cluster_number - b.cluster_number);
    } else if (sortBy === 'name_desc') {
      list.sort((a, b) => b.cluster_number - a.cluster_number);
    }

    return list;
  }, [clusters, search, sortBy]);

  return (
    <aside className={`${styles.sidebar}`}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.headerTitle}>
            <Sparkles size={14} className={styles.titleIcon} />
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

      <div className={styles.searchWrap}>
        <Search size={13} className={styles.searchIcon} />
        <input
          className={styles.searchInput}
          placeholder="Filtrar grupos..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <button className={styles.searchClear} onClick={() => setSearch('')} type="button" title="Limpar filtro">
            <X size={11} />
          </button>
        )}
      </div>

      {/* Seletor de Ordenação */}
      <div className={styles.filterWrap}>
        <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', fontWeight: 500 }}>Ordenar por:</span>
        <select
          className={styles.filterSelect}
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortOption)}
          style={{ width: '100%', marginTop: '4px' }}
        >
          <option value="photo_count_desc">Quantidade de fotos</option>
          <option value="name_asc">Número do Grupo (Crescente)</option>
          <option value="name_desc">Número do Grupo (Decrescente)</option>
        </select>
      </div>

      {/* Cluster list */}
      <div className={styles.list}>
        {loading && clusters.length === 0 ? (
          <div className={styles.listSkeleton}>
            {Array.from({ length: 6 }).map((_, idx) => (
              <div key={idx} className={styles.itemSkeleton}>
                <div className={styles.avatarSkeleton} />
                <div className={styles.itemInfo}>
                  <div className={styles.textSkeleton} style={{ width: '55%', marginBottom: '4px' }} />
                  <div className={styles.textSkeleton} style={{ width: '80%', height: '16px', borderRadius: '4px', marginBottom: '4px' }} />
                  <div className={styles.textSkeleton} style={{ width: '35%', height: '8px' }} />
                </div>
              </div>
            ))}
          </div>
        ) : processedClusters.length === 0 ? (
          <div className={styles.listState}>
            <span>
              {search
                ? 'Sem resultados'
                : reviewReady
                ? 'Tudo identificado!'
                : 'Ainda preparando revisão...'}
            </span>
          </div>
        ) : (
          <>
            {processedClusters.map((cluster) => (
              <ClusterItem
                key={cluster.cluster_id}
                cluster={cluster}
                isSelected={cluster.cluster_id === selectedId}
                onClick={onSelect}
                clusterId={cluster.cluster_id}
              />
            ))}
            {hasMore && !search.trim() && (
              <button
                type="button"
                className={styles.loadMoreButton}
                onClick={onLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? 'Carregando mais...' : 'Carregar mais grupos'}
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
