import { useState } from 'react';
import { ChevronDown, ChevronUp, Cpu, RefreshCw, Sparkles } from 'lucide-react';
import type { GraduationAnalysisStatus } from '../../services/api';
import styles from '../../views/ReviewView.module.css';

interface Props {
  status: GraduationAnalysisStatus | null;
  isStarting: boolean;
  onStart: (useAiUltra: boolean) => void;
}

export default function GraduationAnalysisPanel({ status, isStarting, onStart }: Props) {
  const [open, setOpen] = useState(false);

  const isRunning = Boolean(status?.is_running);
  const progress = Math.max(0, Math.min(100, (status?.progress ?? 0) * 100));
  const hasResult = Boolean(status?.result);
  const buttonLabel = isRunning || isStarting ? 'Analisando...' : (hasResult ? 'Reanalisar' : 'Analisar');

  let compactStatus: string;
  if (isStarting && !isRunning) {
    compactStatus = 'Preparando análise local...';
  } else if (isRunning) {
    compactStatus = `Analisando com classificador local: ${status?.processed ?? 0}/${status?.total ?? 0} (${Math.round(progress)}%)`;
  } else if (status?.error) {
    compactStatus = status.error;
  } else if (status?.result) {
    const n = status.result.processed_files;
    compactStatus = `Análise concluída (classificador local): ${n} foto${n !== 1 ? 's' : ''}`;
  } else {
    compactStatus = 'Itens de formatura não analisados';
  }

  return (
    <div className={`${styles.analysisPanel} ${open ? styles.analysisPanelOpen : ''}`}>
      <div className={styles.analysisCompact}>
        <span className={styles.analysisEyebrow}>
          <Sparkles size={11} />
          <span>{compactStatus}</span>
          {!isRunning && !isStarting && (
            <span className={styles.badgeReady}>
              <span className={styles.pulseGreen} />
              Classificador local ativo
            </span>
          )}
        </span>

        {(isRunning || isStarting) && (
          <span className={styles.analysisCompactBar}>
            <span
              className={`${styles.analysisCompactBarFill} ${isStarting && !isRunning ? styles.analysisCompactBarIndeterminate : ''}`}
              style={isRunning ? { width: `${progress}%` } : undefined}
            />
          </span>
        )}

        <button
          type="button"
          className={styles.analysisButton}
          onClick={() => onStart(true)}
          disabled={isRunning || isStarting}
        >
          <RefreshCw
            size={11}
            className={`${styles.spin} ${isRunning || isStarting ? styles.inlineVisible : styles.inlineHidden}`}
          />
          <span>{buttonLabel}</span>
        </button>

        <button
          type="button"
          className={styles.analysisToggle}
          onClick={() => setOpen(v => !v)}
          title={open ? 'Recolher' : 'Detalhes'}
        >
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>

      {open && (
        <div className={styles.analysisDetails}>
          <p className={styles.analysisStatus}>
            <span>
              Classificador multi-label local para beca, faixa, capelo, canudo e jabor. A análise usa apenas o rosto expandido da pessoa e grava as probabilidades no banco.
            </span>
          </p>

          <div className={styles.modeSelector}>
            <div className={`${styles.modeCard} ${styles.modeCardActive}`}>
              <span className={styles.modeCardTitle}>
                <Cpu size={13} />
                GraduationClassifier
              </span>
              <span className={styles.modeCardDesc}>
                Entrada 224x224, inferência local e compatível com GPU/CPU via ONNX. Quando o modelo ONNX estiver presente, ele é usado automaticamente; caso contrário, o sistema mantém um fallback local conservador para não quebrar catálogos antigos.
              </span>
            </div>
          </div>

          {(isRunning || hasResult) && (
            <div className={styles.analysisProgressWrap} style={{ marginTop: '12px' }}>
              <div className={styles.analysisProgressMeta}>
                <span style={{ fontWeight: 500, fontSize: '0.72rem' }}>Progresso da triagem local</span>
                <span>{status?.processed ?? 0} / {status?.total ?? 0} fotos ({Math.round(progress)}%)</span>
              </div>
              <div className={styles.analysisProgressTrack}>
                <div className={styles.analysisProgressFill} style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {!isRunning && status?.result && (
            <div className={styles.analysisResult} style={{ marginTop: '8px', padding: '6px 0', display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>
                Último resultado obtido em {status.finished_at ? new Date(status.finished_at * 1000).toLocaleString('pt-BR') : 'análise recente'}:
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                · {status.result.processed_files} foto{status.result.processed_files !== 1 ? 's' : ''} processada{status.result.processed_files !== 1 ? 's' : ''}.
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                · {status.result.updated_faces} registro{status.result.updated_faces !== 1 ? 's' : ''} atualizado{status.result.updated_faces !== 1 ? 's' : ''} no banco.
              </span>
              <span style={{ color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                · Tecnologia:
                <span className={styles.badgeReady} style={{ background: 'transparent', padding: 0, border: 'none', color: '#10b981' }}>
                  Classificador local
                </span>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
