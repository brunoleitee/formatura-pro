import React from 'react';
import { ImageIcon, Info } from 'lucide-react';
import styles from './ScannerEventFolderManager.module.css';

interface FolderData {
  name: string;
  path: string;
  imageCount: number;
}

interface DetailsProps {
  folder: FolderData | null;
}

const ScannerEventFolderDetails: React.FC<DetailsProps> = ({ folder }) => {
  if (!folder) {
    return (
      <div className={styles['scanner-event-manager-loading']}>
        <Info size={40} style={{ opacity: 0.1 }} />
        <span>Selecione uma pasta para ver detalhes</span>
      </div>
    );
  }

  return (
    <div className={styles['scanner-event-manager-details']}>
      <span className={styles['scanner-event-manager-details-label']}>Pasta Selecionada</span>
      <h3 className={styles['scanner-event-manager-details-name']}>{folder.name}</h3>
      
      <span className={styles['scanner-event-manager-details-label']}>Caminho Completo</span>
      <p className={styles['scanner-event-manager-details-path']}>{folder.path}</p>

      <div className={styles['scanner-event-manager-info-card']}>
        <span className={styles['scanner-event-manager-info-value']}>
          {folder.imageCount.toLocaleString()}
        </span>
        <div className={styles['scanner-event-manager-info-text']}>
          <ImageIcon size={14} style={{ marginBottom: 4 }} />
          <div>Imagens detectadas nesta pasta</div>
        </div>
      </div>
    </div>
  );
};

export default ScannerEventFolderDetails;
