import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UserCheck, RefreshCw } from 'lucide-react';
import { api } from '../services/api';
import type { RichCluster } from '../services/api';
import { useApp } from '../context/AppContext';
import ReviewSidebar from '../components/review/ReviewSidebar';
import ClusterDetail from '../components/review/ClusterDetail';
import styles from './ReviewView.module.css';

export default function ReviewView() {
  const { currentCatalog } = useApp();
  const [clusters, setClusters] = useState<RichCluster[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<RichCluster | null>(null);

  const load = useCallback(async () => {
    if (!currentCatalog) return;
    setLoading(true);
    try {
      const data = await api.getUnknownClustersV2(currentCatalog);
      setClusters(data?.clusters ?? []);
    } catch {
      setClusters([]);
    } finally {
      setLoading(false);
    }
  }, [currentCatalog]);

  useEffect(() => {
    setSelected(null);
    load();
  }, [load]);

  const handleAssigned = useCallback((clusterId: string) => {
    setClusters(prev => {
      const next = prev.filter(c => c.cluster_id !== clusterId);
      // Auto-avança para o próximo cluster
      const idx = prev.findIndex(c => c.cluster_id === clusterId);
      setSelected(next[idx] ?? next[idx - 1] ?? null);
      return next;
    });
  }, []);

  const handleSkip = useCallback(() => {
    if (!selected) return;
    const idx = clusters.findIndex(c => c.cluster_id === selected.cluster_id);
    setSelected(clusters[idx + 1] ?? clusters[idx - 1] ?? null);
  }, [selected, clusters]);

  if (!currentCatalog) {
    return (
      <div className={styles.root}>
        <div className={styles.noCatalog}>
          <UserCheck size={40} strokeWidth={1.5} style={{ opacity: 0.25 }} />
          <p>Selecione um evento para começar a revisão.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {/* Sidebar esquerda de clusters */}
      <ReviewSidebar
        clusters={clusters}
        loading={loading}
        selectedId={selected?.cluster_id ?? null}
        onSelect={setSelected}
        onRefresh={load}
      />

      {/* Área principal */}
      <div className={styles.main}>
        <AnimatePresence mode="wait">
          {selected ? (
            <ClusterDetail
              key={selected.cluster_id}
              cluster={selected}
              catalog={currentCatalog}
              onAssigned={handleAssigned}
              onSkip={handleSkip}
            />
          ) : (
            <WelcomeState
              key="welcome"
              count={clusters.length}
              loading={loading}
              onRefresh={load}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function WelcomeState({
  count,
  loading,
  onRefresh,
}: {
  count: number;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <motion.div
      className={styles.welcome}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className={styles.welcomeInner}>
        <div className={styles.welcomeOrb}>
          {loading ? (
            <RefreshCw size={32} strokeWidth={1.5} className={styles.spin} />
          ) : count === 0 ? (
            <UserCheck size={32} strokeWidth={1.5} />
          ) : (
            <UserCheck size={32} strokeWidth={1.5} />
          )}
        </div>

        <h2 className={styles.welcomeTitle}>
          {loading ? 'Calculando agrupamentos...' : count === 0 ? 'Tudo identificado!' : 'Revisão IA'}
        </h2>

        <p className={styles.welcomeSubtitle}>
          {loading
            ? 'A IA está analisando as faces similares...'
            : count === 0
            ? 'Nenhuma face desconhecida pendente neste evento.'
            : `${count} grupo${count !== 1 ? 's' : ''} aguardando identificação. Selecione um grupo na barra lateral para começar.`}
        </p>

        {!loading && count > 0 && (
          <div className={styles.welcomeHint}>
            ← Selecione um grupo para revisar
          </div>
        )}

        {!loading && count === 0 && (
          <button className={styles.welcomeRefresh} onClick={onRefresh}>
            <RefreshCw size={14} />
            Recarregar
          </button>
        )}
      </div>
    </motion.div>
  );
}
