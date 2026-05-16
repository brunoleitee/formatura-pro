import React, { useState, useEffect } from 'react';
import { X, LoaderCircle, RefreshCw } from 'lucide-react';
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
  onApply: (data: { included: string[]; ignored: string[]; monitored: string[] }) => void;
}

const ScannerEventFolderManager: React.FC<ManagerProps> = ({ eventPath, catalogName, onClose, onApply }) => {
  const [loading, setLoading] = useState(true);
  const [folders, setFolders] = useState<FolderData[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<FolderData | null>(null);
  const [folderStatuses, setFolderStatuses] = useState<Record<string, 'include' | 'ignore' | 'monitor'>>({});

  const storageKey = `scanner:eventFolders:${catalogName}:${eventPath}`;

  useEffect(() => {
    // Load persisted statuses
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        setFolderStatuses(JSON.parse(saved));
      } catch (e) {
        console.error('Error parsing saved statuses', e);
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
        
        // Fetch counts for each child
        for (const child of root.children) {
          try {
            const photoRes = await api.explorePhotos(child.path, { limit: 0, recursive: true, include_raw: true });
            folderList.push({
              name: child.name,
              path: child.path,
              imageCount: photoRes.total || 0
            });
          } catch (e) {
            folderList.push({
              name: child.name,
              path: child.path,
              imageCount: 0
            });
          }
        }
        setFolders(folderList);
        if (folderList.length > 0) setSelectedFolder(folderList[0]);
      }
    } catch (err) {
      console.error('Error loading subfolders', err);
    } finally {
      setLoading(false);
    }
  };

  const handleStatusChange = (status: 'include' | 'ignore' | 'monitor') => {
    if (!selectedFolder) return;
    
    const newStatuses = {
      ...folderStatuses,
      [selectedFolder.path]: status
    };
    setFolderStatuses(newStatuses);
    localStorage.setItem(storageKey, JSON.stringify(newStatuses));
  };

  const handleApply = () => {
    const included: string[] = [];
    const ignored: string[] = [];
    const monitored: string[] = [];

    Object.entries(folderStatuses).forEach(([path, status]) => {
      if (status === 'include') included.push(path);
      else if (status === 'ignore') ignored.push(path);
      else if (status === 'monitor') monitored.push(path);
    });

    onApply({ included, ignored, monitored });
    onClose();
  };

  return (
    <div className={styles['scanner-event-manager-container']}>
      <div className={styles['scanner-event-manager-header']}>
        <span className={styles['scanner-event-manager-title']}>Gerenciador de Subpastas do Evento</span>
        <button className={styles['scanner-event-manager-close']} onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div className={styles['scanner-event-manager-body']}>
        <div className={styles['scanner-event-manager-left']}>
          {loading ? (
            <div className={styles['scanner-event-manager-loading']}>
              <LoaderCircle size={24} className={styles['scanner-event-manager-spin']} />
              <span>Carregando subpastas...</span>
            </div>
          ) : (
            <ScannerEventFolderTree 
              folders={folders}
              selectedPath={selectedFolder?.path || ''}
              onSelect={setSelectedFolder}
              folderStatuses={folderStatuses}
            />
          )}
        </div>
        
        <div className={styles['scanner-event-manager-right']}>
          <ScannerEventFolderDetails 
            folder={selectedFolder}
            status={selectedFolder ? (folderStatuses[selectedFolder.path] || 'include') : 'include'}
            onStatusChange={handleStatusChange}
          />
        </div>
      </div>

      <div className={styles['scanner-event-manager-footer']}>
        <button className={styles['scanner-event-manager-close']} onClick={onClose} style={{ padding: '8px 16px' }}>
          Cancelar
        </button>
        <button className={styles['scanner-event-manager-apply-btn']} onClick={handleApply}>
          Aplicar ao Scanner
        </button>
      </div>
    </div>
  );
};

export default ScannerEventFolderManager;
