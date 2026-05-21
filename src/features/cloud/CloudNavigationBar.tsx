import { ArrowLeft, ArrowRight, Cloud, FolderOpen, HardDrive, RefreshCw, Upload, Zap } from 'lucide-react';
import styles from '../../views/CloudView.module.css';

type CloudNavigationBarProps = {
  currentFolderName: string;
  cacheSize?: number;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  canGoUp: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
};

function formatCacheSize(value?: number) {
  if (!value) return '0 MB';
  if (value < 1024) return `${value} MB`;
  return `${(value / 1024).toFixed(1)} GB`;
}

export function CloudNavigationBar({
  currentFolderName,
  cacheSize = 0,
  loading,
  canGoBack,
  canGoForward,
  canGoUp,
  onBack,
  onForward,
  onUp,
  onRefresh,
}: CloudNavigationBarProps) {
  return (
    <div className={styles.cloudNavBar}>
      <div className={styles.navButtons}>
        <button type="button" onClick={onBack} disabled={!canGoBack} title="Voltar">
          <ArrowLeft size={15} />
          Voltar
        </button>
        <button type="button" onClick={onForward} disabled={!canGoForward} title="Avançar">
          <ArrowRight size={15} />
          Avançar
        </button>
        <button type="button" onClick={onUp} disabled={!canGoUp} title="Subir pasta">
          <Upload size={15} />
          Subir pasta
        </button>
        <button type="button" onClick={onRefresh} disabled={loading} title="Atualizar">
          <RefreshCw size={15} className={loading ? styles.spin : undefined} />
          Atualizar
        </button>
      </div>

      <div className={styles.cloudToolbar}>
        <span><Cloud size={14} /> Google Drive</span>
        <span><Zap size={14} /> Cache ativo</span>
        <span><HardDrive size={14} /> {formatCacheSize(cacheSize)}</span>
        <span><FolderOpen size={14} /> {currentFolderName}</span>
      </div>
    </div>
  );
}
