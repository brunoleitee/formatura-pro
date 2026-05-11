import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import type { RichCluster } from '../../services/api';
import styles from './ClusterStatsPanel.module.css';

interface ClusterStatsPanelProps {
  cluster: RichCluster;
  selectedCount: number;
}

type Tab = 'overview' | 'analysis';

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color?: 'white' | 'green' | 'yellow' | 'red';
}) {
  return (
    <div className={styles.statCard}>
      <div className={`${styles.statValue} ${color ? styles[color] : styles.white}`}>
        {value}
      </div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  );
}

export default function ClusterStatsPanel({
  cluster,
  selectedCount,
}: ClusterStatsPanelProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const pct = Math.round(cluster.cohesion_score * 100);
  const pending = Math.max(0, cluster.face_count - selectedCount);

  // Quality breakdown from faces
  const sharpCount = cluster.faces.filter(f => f.blur_status === 'sharp').length;
  const attentionCount = cluster.faces.filter(f => f.blur_status === 'attention').length;
  const blurryCount = cluster.faces.filter(f => f.blur_status === 'blurry').length;

  return (
    <div className={styles.panel}>
      {/* Tabs */}
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === 'overview' ? styles.tabActive : ''}`}
          onClick={() => setTab('overview')}
        >
          Visão geral
        </button>
        <button
          className={`${styles.tab} ${tab === 'analysis' ? styles.tabActive : ''}`}
          onClick={() => setTab('analysis')}
        >
          Análise do grupo
        </button>
      </div>

      <div className={styles.body}>
        {tab === 'overview' ? (
          <>
            {/* 4 stat cards em grid 2x2 */}
            <div className={styles.statsGrid}>
              <StatCard label="Fotos totais" value={cluster.face_count} color="white" />
              <StatCard label="Selecionadas" value={selectedCount} color="green" />
              <StatCard label="Pendentes" value={pending} color="yellow" />
              <StatCard label="Descartadas" value={0} color="red" />
            </div>

            {/* Barra de confiança */}
            <div className={styles.confidence}>
              <div className={styles.confHeader}>
                <div className={styles.confRow}>
                  <span className={styles.confPct}>{pct}%</span>
                  <span className={styles.confLabel}>Confiança do grupo</span>
                  <HelpCircle size={12} className={styles.confHelp} />
                </div>
              </div>
              <div className={styles.confBarWrap}>
                <div
                  className={styles.confBar}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          </>
        ) : (
          /* Análise do grupo */
          <div className={styles.analysis}>
            <p className={styles.analysisTitle}>Qualidade das fotos</p>
            <div className={styles.qualityBars}>
              <QualityRow label="Nítidas" count={sharpCount} total={cluster.face_count} color="#10b981" />
              <QualityRow label="Suave" count={attentionCount} total={cluster.face_count} color="#f59e0b" />
              <QualityRow label="Desfocadas" count={blurryCount} total={cluster.face_count} color="#ef4444" />
              {cluster.face_count - sharpCount - attentionCount - blurryCount > 0 && (
                <QualityRow
                  label="Não analisadas"
                  count={cluster.face_count - sharpCount - attentionCount - blurryCount}
                  total={cluster.face_count}
                  color="#475569"
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function QualityRow({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className={styles.qualityRow}>
      <div className={styles.qualityMeta}>
        <span className={styles.qualityLabel}>{label}</span>
        <span className={styles.qualityCount}>{count}</span>
      </div>
      <div className={styles.qualityBarWrap}>
        <div className={styles.qualityBar} style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
