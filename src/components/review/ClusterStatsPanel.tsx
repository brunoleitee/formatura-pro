import { useState, memo, useMemo } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, GitCompare, HelpCircle, Sparkles, X } from 'lucide-react';
import type { RichCluster } from '../../services/api';
import styles from './ClusterStatsPanel.module.css';

interface ClusterStatsPanelProps {
  cluster: RichCluster;
  selectedCount: number;
  totalSelectable: number;
  onSelectBest: () => void;
  onSelectAll: () => void;
  compareStudent?: string | null;
  compareSimilarity?: number | null;
  onCompare?: () => void;
}

type Tab = 'overview' | 'analysis';
type GraduationItem = 'gown' | 'diploma' | 'sash' | 'cap' | 'jabor';

const ITEM_LABEL: Record<GraduationItem, string> = {
  gown: 'Beca',
  diploma: 'Canudo',
  sash: 'Faixa',
  cap: 'Capelo',
  jabor: 'Jabor',
};

const ITEM_CONFIDENCE_KEY: Record<GraduationItem, keyof RichCluster> = {
  gown: 'gown_confidence',
  diploma: 'diploma_confidence',
  sash: 'sash_confidence',
  cap: 'cap_confidence',
  jabor: 'jabor_confidence',
};

const ITEM_HAS_KEY: Record<GraduationItem, keyof RichCluster> = {
  gown: 'has_gown',
  diploma: 'has_diploma',
  sash: 'has_sash',
  cap: 'has_cap',
  jabor: 'has_jabor',
};

const ITEMS: GraduationItem[] = ['gown', 'sash', 'cap', 'diploma', 'jabor'];

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionTitle}>
        <X size={11} />
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

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

export default memo(function ClusterStatsPanel({
  cluster,
  selectedCount,
  totalSelectable,
  onSelectBest,
  onSelectAll,
  compareStudent,
  compareSimilarity,
  onCompare,
}: ClusterStatsPanelProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const pct = useMemo(() => Math.round(cluster.cohesion_score * 100), [cluster.cohesion_score]);
  const pending = useMemo(() => Math.max(0, cluster.face_count - selectedCount), [cluster.face_count, selectedCount]);
  const compareEnabled = !!compareStudent && compareSimilarity != null && isFinite(compareSimilarity) && compareSimilarity >= 0.30;

  const qualityStats = useMemo(() => ({
    sharp: cluster.faces.filter(f => f.blur_status === 'sharp').length,
    attention: cluster.faces.filter(f => f.blur_status === 'attention').length,
    blurry: cluster.faces.filter(f => f.blur_status === 'blurry').length,
  }), [cluster.faces]);

  const fgCount = useMemo(() =>
    cluster.faces.filter(f => f.is_foreground === 1 || (f.foreground_score && f.foreground_score >= 0.65)).length,
  [cluster.faces]);

  const bgCount = useMemo(() =>
    cluster.faces.filter(f => f.is_foreground === 0 || (f.foreground_score && f.foreground_score < 0.45)).length,
  [cluster.faces]);

  const bgReasons = useMemo(() => {
    const bgFaces = cluster.faces.filter(f => f.is_foreground === 0 || (f.foreground_score && f.foreground_score < 0.45));
    const reasons: Record<string, number> = {};
    for (const f of bgFaces) {
      if (f.background_penalty_reason) {
        reasons[f.background_penalty_reason] = (reasons[f.background_penalty_reason] || 0) + 1;
      }
    }
    return Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  }, [cluster.faces]);

  const detectedItems = useMemo(() => ITEMS.map(item => {
    const conf = (cluster[ITEM_CONFIDENCE_KEY[item]] as number | undefined)
      ?? ((cluster[ITEM_HAS_KEY[item]] as boolean | undefined) ? 1 : 0);
    return {
      item,
      label: ITEM_LABEL[item],
      confidence: Math.round(Math.max(0, Math.min(1, conf || 0)) * 100),
      visible: (conf || 0) > 0 || Boolean(cluster[ITEM_HAS_KEY[item]]),
    };
  }).filter(item => item.visible), [cluster]);

  const qualityLabel = useMemo(() => {
    if (qualityStats.sharp >= Math.max(1, Math.ceil(cluster.face_count * 0.65))) return 'Alta';
    if (qualityStats.blurry >= Math.max(1, Math.ceil(cluster.face_count * 0.45))) return 'Baixa';
    return 'Média';
  }, [cluster.face_count, qualityStats.blurry, qualityStats.sharp]);

  const poseLabel = useMemo(() => {
    if (bgCount >= Math.max(1, Math.ceil(cluster.face_count * 0.45))) return 'Alta';
    if (bgCount > 0) return 'Média';
    return 'Baixa';
  }, [bgCount, cluster.face_count]);

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

            <Section title="Análise rápida">
              <div className={styles.quickList}>
                <div className={styles.quickRow}>
                  <span>Rosto principal</span>
                  <strong className={styles.green}>{pct}%</strong>
                </div>
                <div className={styles.quickRow}>
                  <span>Qualidade média</span>
                  <strong className={qualityLabel === 'Baixa' ? styles.red : qualityLabel === 'Média' ? styles.yellow : styles.green}>
                    {qualityLabel}
                  </strong>
                </div>
                <div className={styles.quickRow}>
                  <span>Grupo coeso</span>
                  <strong className={pct >= 70 ? styles.green : pct >= 50 ? styles.yellow : styles.red}>
                    {pct >= 70 ? 'Sim' : pct >= 50 ? 'Parcial' : 'Não'}
                  </strong>
                </div>
                <div className={styles.quickRow}>
                  <span>Variação de pose</span>
                  <strong className={poseLabel === 'Alta' ? styles.red : poseLabel === 'Média' ? styles.yellow : styles.green}>
                    {poseLabel}
                  </strong>
                </div>
              </div>
            </Section>

            <Section title="Itens detectados">
              {detectedItems.length > 0 ? (
                <div className={styles.itemPills}>
                  {detectedItems.map(item => (
                    <span key={item.item} className={styles.itemPill}>
                      <span>{item.label}</span>
                      <strong className={item.confidence >= 70 ? styles.green : item.confidence >= 40 ? styles.yellow : styles.red}>
                        {item.confidence}%
                      </strong>
                    </span>
                  ))}
                </div>
              ) : (
                <span className={styles.emptyLine}>Nenhum item detectado</span>
              )}
            </Section>

            <Section title="Ações rápidas">
              <div className={styles.actionGrid}>
                <button type="button" className={styles.actionBtn} onClick={onSelectBest}>
                  <Sparkles size={12} />
                  <span>Selecionar melhores</span>
                </button>
                <button
                  type="button"
                  className={styles.actionBtn}
                  onClick={onSelectAll}
                  disabled={totalSelectable === 0}
                >
                  <span>Marcar todas</span>
                </button>
                <button type="button" className={`${styles.actionBtn} ${styles.actionDanger}`} disabled>
                  <span>Descartar selecionadas</span>
                </button>
                <button
                  type="button"
                  className={`${styles.actionBtn} ${styles.actionAccent}`}
                  onClick={compareEnabled ? onCompare : undefined}
                  disabled={!compareEnabled}
                >
                  <GitCompare size={12} />
                  <span>Comparar grupo</span>
                </button>
              </div>
            </Section>

            <Section title="Logs">
              <div className={styles.logs}>
                <div className={styles.logRow}>
                  <CheckCircle2 size={11} />
                  <span>Grupo criado automaticamente pela IA</span>
                </div>
                <div className={styles.logRow}>
                  <CheckCircle2 size={11} />
                  <span>Análise de coesão concluída</span>
                </div>
              </div>
            </Section>
          </>
        ) : (
          /* Análise do grupo */
          <div className={styles.analysis}>
            <p className={styles.analysisTitle}>Qualidade das fotos</p>
            <div className={styles.qualityBars}>
              <QualityRow label="Nítidas" count={qualityStats.sharp} total={cluster.face_count} color="#10b981" />
              <QualityRow label="Suave" count={qualityStats.attention} total={cluster.face_count} color="#f59e0b" />
              <QualityRow label="Desfocadas" count={qualityStats.blurry} total={cluster.face_count} color="#ef4444" />
              {cluster.face_count - qualityStats.sharp - qualityStats.attention - qualityStats.blurry > 0 && (
                <QualityRow
                  label="Não analisadas"
                  count={cluster.face_count - qualityStats.sharp - qualityStats.attention - qualityStats.blurry}
                  total={cluster.face_count}
                  color="#475569"
                />
              )}
            </div>
            
            <p className={styles.analysisTitle} style={{ marginTop: '12px' }}>Primeiro e Segundo Plano</p>
            <div className={styles.qualityBars}>
              <QualityRow label="1º Plano" count={fgCount} total={cluster.face_count} color="#10b981" />
              <QualityRow label="2º Plano" count={bgCount} total={cluster.face_count} color="#f59e0b" />
            </div>

            {/* Agrupar razões de 2º plano */}
            {bgReasons.length > 0 && (
              <>
                <p className={styles.analysisTitle} style={{ marginTop: '12px', fontSize: '11px', color: '#94a3b8' }}>Razões para 2º plano</p>
                <div className={styles.qualityBars}>
                  {bgReasons.map(([reason, count]) => (
                    <QualityRow key={reason} label={reason} count={count} total={bgCount} color="#64748b" />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

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
