import React from 'react';
import { Folder, CheckCircle2, XCircle, Eye, ChevronRight } from 'lucide-react';
import styles from './ScannerEventFolderManager.module.css';

interface FolderData {
  name: string;
  path: string;
  imageCount: number;
  children?: FolderData[];
}

interface TreeProps {
  folders: FolderData[];
  selectedPath: string;
  onSelect: (folder: FolderData) => void;
  folderStatuses: Record<string, 'include' | 'ignore' | 'monitor'>;
}

const ScannerEventFolderTree: React.FC<TreeProps> = ({ folders, selectedPath, onSelect, folderStatuses }) => {
  const renderIcon = (status?: string) => {
    switch (status) {
      case 'include': return <CheckCircle2 size={12} className={styles['status-include']} />;
      case 'ignore': return <XCircle size={12} className={styles['status-ignore']} />;
      case 'monitor': return <Eye size={12} className={styles['status-monitor']} />;
      default: return null;
    }
  };

  return (
    <div className={styles['scanner-event-manager-tree']}>
      {folders.length === 0 ? (
        <div className={styles['scanner-event-manager-loading']}>
          <span>Nenhuma subpasta encontrada</span>
        </div>
      ) : (
        folders.map((folder) => {
          const isActive = selectedPath === folder.path;
          const status = folderStatuses[folder.path];

          return (
            <div 
              key={folder.path}
              className={`${styles['scanner-event-manager-tree-item']} ${isActive ? styles['scanner-event-manager-tree-item-active'] : ''}`}
              onClick={() => onSelect(folder)}
            >
              <Folder size={14} />
              <span className={styles['scanner-event-manager-tree-item-name']}>{folder.name}</span>
              {folder.imageCount > 0 && (
                <span style={{ fontSize: '9px', opacity: 0.5 }}>({folder.imageCount})</span>
              )}
              <div className={styles['scanner-event-manager-status-icon']}>
                {renderIcon(status)}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
};

export default ScannerEventFolderTree;
