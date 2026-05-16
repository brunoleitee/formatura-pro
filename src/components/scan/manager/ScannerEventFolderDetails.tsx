import React from 'react';
import { CheckCircle2, XCircle, Eye, Info, ImageIcon, HardDrive } from 'lucide-react';
import styles from './ScannerEventFolderManager.module.css';

interface FolderData {
  name: string;
  path: string;
  imageCount: number;
}

interface DetailsProps {
  folder: FolderData | null;
  status: 'include' | 'ignore' | 'monitor';
  onStatusChange: (status: 'include' | 'ignore' | 'monitor') => void;
}

const ScannerEventFolderDetails: React.FC<DetailsProps> = ({ folder, status, onStatusChange }) => {
  if (!folder) {
    return (
      <div className={styles['scanner-event-manager-loading']}>
        <Info size={24} style={{ opacity: 0.2 }} />
        <span>Selecione uma pasta para ver detalhes</span>
      </div>
    );
  }

  return (
    <div className={styles['scanner-event-manager-details']}>
      <div className={styles['scanner-event-manager-details-header']}>
        <h3 className={styles['scanner-event-manager-details-name']}>{folder.name}</h3>
        <p className={styles['scanner-event-manager-details-path']}>{folder.path}</p>
      </div>

      <div className={styles['scanner-event-manager-stats-row']}>
        <div className={styles['scanner-event-manager-stat']}>
          <span className={styles['scanner-event-manager-stat-label']}>Imagens</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <ImageIcon size={14} className={styles['status-include']} />
            <span className={styles['scanner-event-manager-stat-value']}>{folder.imageCount.toLocaleString()}</span>
          </div>
        </div>
        <div className={styles['scanner-event-manager-stat']}>
          <span className={styles['scanner-event-manager-stat-label']}>Status Atual</span>
          <span className={`${styles['scanner-event-manager-stat-value']} ${styles[`status-${status}`]}`}>
            {status === 'include' ? 'Incluído' : status === 'ignore' ? 'Ignorado' : 'Monitorado'}
          </span>
        </div>
      </div>

      <div className={styles['scanner-event-manager-action-group']}>
        <h4 className={styles['scanner-event-manager-action-title']}>Ações para esta pasta:</h4>
        
        <div className={styles['scanner-event-manager-btn-group']}>
          <button 
            className={`${styles['scanner-event-manager-btn']} ${status === 'include' ? styles['scanner-event-manager-btn-active-include'] : ''}`}
            onClick={() => onStatusChange('include')}
          >
            <CheckCircle2 size={20} />
            <span>Incluir uma vez</span>
          </button>

          <button 
            className={`${styles['scanner-event-manager-btn']} ${status === 'ignore' ? styles['scanner-event-manager-btn-active-ignore'] : ''}`}
            onClick={() => onStatusChange('ignore')}
          >
            <XCircle size={20} />
            <span>Ignorar pasta</span>
          </button>

          <button 
            className={`${styles['scanner-event-manager-btn']} ${status === 'monitor' ? styles['scanner-event-manager-btn-active-monitor'] : ''}`}
            onClick={() => onStatusChange('monitor')}
          >
            <Eye size={20} />
            <span>Monitorar sempre</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScannerEventFolderDetails;
