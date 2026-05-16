import React from 'react';
import { Folder, Check } from 'lucide-react';
import styles from './ScannerEventFolderManager.module.css';

interface FolderData {
  name: string;
  path: string;
  imageCount: number;
}

interface TreeProps {
  folders: FolderData[];
  selectedPath: string;
  onSelect: (folder: FolderData) => void;
  selectedPaths: string[];
  onToggle: (path: string) => void;
}

const ScannerEventFolderTree: React.FC<TreeProps> = ({ folders, selectedPath, onSelect, selectedPaths, onToggle }) => {
  return (
    <div className={styles['scanner-event-manager-tree']}>
      {folders.length === 0 ? (
        <div className={styles['scanner-event-manager-loading']}>
          <span>Nenhuma subpasta encontrada</span>
        </div>
      ) : (
        folders.map((folder) => {
          const isActive = selectedPath === folder.path;
          const isSelected = selectedPaths.includes(folder.path);

          return (
            <div 
              key={folder.path}
              className={`${styles['scanner-event-manager-tree-item']} ${isActive ? styles['scanner-event-manager-tree-item-active'] : ''}`}
              onClick={() => onSelect(folder)}
            >
              <div 
                className={`${styles['scanner-event-manager-checkbox']} ${isSelected ? styles['scanner-event-manager-checkbox-checked'] : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(folder.path);
                }}
              >
                {isSelected && <Check size={10} />}
              </div>
              
              <Folder size={14} style={{ opacity: isSelected ? 1 : 0.4 }} />
              <span style={{ opacity: isSelected ? 1 : 0.6 }}>{folder.name}</span>
            </div>
          );
        })
      )}
    </div>
  );
};

export default ScannerEventFolderTree;
