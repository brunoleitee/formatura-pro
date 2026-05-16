import React, { useState, useEffect } from 'react';
import { X, LoaderCircle } from 'lucide-react';
import ScannerEventFolderTree from './ScannerEventFolderTree';
import ScannerEventFolderDetails from './ScannerEventFolderDetails';
import { api } from '../../../services/api';
import styles from './ScannerEventFolderManager.module.css';

interface FolderData {
  name: string;
  path: string;
  imageCount: number;
}

interface ManagerProps {
  eventPath: string;
  catalogName: string;
  onClose: () => void;
  onApply: (selectedFolders: string[]) => void;
}

const ScannerEventFolderManager: React.FC<ManagerProps> = ({ eventPath, catalogName, onClose, onApply }) => {
  const [loading, setLoading] = useState(true);
  const [folders, setFolders] = useState<FolderData[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<FolderData | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);

  const storageKey = `scanner:selectedFolders:${catalogName}:${eventPath}`;

  useEffect(() => {
    // Load persisted selections
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        setSelectedPaths(JSON.parse(saved));
      } catch (e) {
        console.error('Error parsing saved selections', e);
      }
    }

    loadSubfolders();
  }, [eventPath]);

  const loadSubfolders = async () => {
    setLoading(true);
    try {
      const treeRes = await api.exploreTree(eventPath, 1);
      const root = Array.isArray(treeRes.tree) ? treeRes.tree[0] : treeRes.tree;
      
      if (root && root.children) {
        const folderList: FolderData[] = [];
        
        for (const child of root.children) {
          try {
            const photoRes = await api.explorePhotos(child.path, { limit: 0, recursive: true, include_raw: true });
            folderList.push({
              name: child.name,
              path: child.path,
              imageCount: photoRes.total || 0
            });
          } catch (e) {
            folderList.push({ name: child.name, path: child.path, imageCount: 0 });
          }
        }
        setFolders(folderList);
        if (folderList.length > 0) setSelectedFolder(folderList[0]);
        
        // If first time, select all by default if no saved state
        if (!localStorage.getItem(storageKey)) {
          setSelectedPaths(folderList.map(f => f.path));
        }
      }
    } catch (err) {
      console.error('Error loading subfolders', err);
    } finally {
      setLoading(false);
    }
  };

  const togglePath = (path: string) => {
    setSelectedPaths(prev => 
      prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
    );
  };

  const selectAll = () => setSelectedPaths(folders.map(f => f.path));
  const deselectAll = () => setSelectedPaths([]);

  const handleApply = () => {
    localStorage.setItem(storageKey, JSON.stringify(selectedPaths));
    onApply(selectedPaths);
    onClose();
  };

  return (
    <div className={styles['scanner-event-manager-overlay']} onClick={onClose}>
      <div className={styles['scanner-event-manager-modal']} onClick={e => e.stopPropagation()}>
        <div className={styles['scanner-event-manager-header']}>
          <span className={styles['scanner-event-manager-title']}>Gerenciador de Pastas (Picasa Style)</span>
          <button className={styles['scanner-event-manager-close']} onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className={styles['scanner-event-manager-toolbar']}>
          <button className={styles['scanner-event-manager-tool-btn']} onClick={selectAll}>
            Marcar Todas
          </button>
          <button className={styles['scanner-event-manager-tool-btn']} onClick={deselectAll}>
            Desmarcar Todas
          </button>
        </div>

        <div className={styles['scanner-event-manager-body']}>
          <div className={styles['scanner-event-manager-left']}>
            {loading ? (
              <div className={styles['scanner-event-manager-loading']}>
                <LoaderCircle size={32} className={styles['scanner-event-manager-spin']} />
                <span>Buscando subpastas...</span>
              </div>
            ) : (
              <ScannerEventFolderTree 
                folders={folders}
                selectedPath={selectedFolder?.path || ''}
                onSelect={setSelectedFolder}
                selectedPaths={selectedPaths}
                onToggle={togglePath}
              />
            )}
          </div>
          
          <div className={styles['scanner-event-manager-right']}>
            <ScannerEventFolderDetails folder={selectedFolder} />
          </div>
        </div>

        <div className={styles['scanner-event-manager-footer']}>
          <button className={styles['scanner-event-manager-btn-cancel']} onClick={onClose}>
            Cancelar
          </button>
          <button className={styles['scanner-event-manager-apply-btn']} onClick={handleApply}>
            Aplicar ao Scanner
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScannerEventFolderManager;
