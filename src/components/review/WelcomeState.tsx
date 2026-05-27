import { RefreshCw, UserCheck } from 'lucide-react';
import styles from '../../views/ReviewView.module.css';

interface Props {
  count: number;
  loading: boolean;
  reviewReady?: boolean;
  totalFacesInCatalog?: number;
  loadingMessage?: string;
  onRefresh: () => void;
}

export default function WelcomeState({
  count,
  loading,
  reviewReady = true,
  totalFacesInCatalog = 0,
  loadingMessage = 'Carregando grupos salvos...',
  onRefresh,
}: Props) {
  const hasNoFaces = totalFacesInCatalog === 0 && count === 0;
  const titleLabel = loading
    ? loadingMessage
    : hasNoFaces
    ? 'Nenhum rosto encontrado'
    : count === 0
    ? (reviewReady ? 'Tudo identificado!' : 'Ainda preparando a revisão')
    : 'Revisão IA';
  const subtitleLabel = loading
    ? 'A primeira página está sendo carregada a partir dos clusters já salvos no catálogo.'
    : hasNoFaces
    ? 'O Scanner processou as fotos, mas nenhum rosto foi detectado nelas.'
    : count === 0
    ? (reviewReady
      ? 'Nenhuma face desconhecida pendente neste evento.'
      : 'Os dados da revisão ainda estão sendo preparados em segundo plano.')
    : `${count} grupo${count !== 1 ? 's' : ''} aguardando identificação. Selecione um grupo na barra lateral para começar.`;

  return (
    <div className={styles.welcome}>
      <div className={styles.welcomeInner}>
        <div className={styles.welcomeOrb}>
          {loading ? (
            <RefreshCw size={32} strokeWidth={1.5} className={styles.spin} />
          ) : (
            <UserCheck size={32} strokeWidth={1.5} />
          )}
        </div>

        <h2 className={styles.welcomeTitle}>
          <span>{titleLabel}</span>
        </h2>

        <p className={styles.welcomeSubtitle}>
          <span>{subtitleLabel}</span>
        </p>

        <div className={`${styles.welcomeHint} ${!loading && count > 0 ? styles.blockVisible : styles.blockHidden}`}>
          <span>← Selecione um grupo para revisar</span>
        </div>

        <button
          className={`${styles.welcomeRefresh} ${!loading && count === 0 ? styles.inlineFlexVisible : styles.inlineFlexHidden}`}
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw size={14} />
          <span>Recarregar</span>
        </button>
      </div>
    </div>
  );
}
