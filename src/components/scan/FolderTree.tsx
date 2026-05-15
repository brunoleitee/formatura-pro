import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Folder, ChevronRight, ChevronDown, FileType, 
  Image as ImageIcon, Video, Camera, Info, 
  AlertCircle, CheckCircle2, LoaderCircle, FileCode, Search
} from 'lucide-react';
import { api, type FolderTreeItem, type FolderTreeResponse } from '../../services/api';
import styles from './FolderTree.module.css';

interface FolderTreeProps {
  rootPath: string;
  onSelectFolder: (path: string) => void;
  selectedPath?: string;
}

const FolderTree: React.FC<FolderTreeProps> = ({ rootPath, onSelectFolder, selectedPath }) => {
  const [tree, setTree] = useState<FolderTreeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const fetchTree = useCallback(async (path: string) => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.exploreTree(path, 10);
      if (res.ok) {
        setTree(res);
        // Auto-expand root
        setExpanded(prev => ({ ...prev, [res.path]: true }));
      } else {
        setError(res.error || 'Erro ao ler pasta');
      }
    } catch (err) {
      setError('Falha na comunicação com o backend');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTree(rootPath);
  }, [rootPath, fetchTree]);

  const toggleExpand = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    setExpanded(prev => ({ ...prev, [path]: !prev[path] }));
  };

  const getStatusColor = (item: FolderTreeItem) => {
    if (item.total_files === 0) return styles.statusRed;
    if (item.total_files < 10) return styles.statusYellow;
    return styles.statusGreen;
  };

  const renderItem = (item: FolderTreeItem | FolderTreeResponse, isRoot = false) => {
    const path = item.path;
    const isExpanded = expanded[path];
    const isSelected = selectedPath === path;
    const hasChildren = 'children' in item && item.children && item.children.length > 0;
    
    // Type narrow for FolderTreeItem to get counts
    const counts = (item as FolderTreeItem).counts || (item as FolderTreeResponse);
    const hasRaw = (counts.RAW || 0) > 0;
    const hasJpg = (counts.JPG || 0) > 0;
    const hasVideo = (counts.MOV || 0) > 0;
    const hasHeic = (counts.HEIC || 0) > 0;

    return (
      <div key={path} className={styles.treeNode}>
        <div 
          className={`${styles.treeItem} ${isSelected ? styles.treeItemSelected : ''}`}
          onClick={() => onSelectFolder(path)}
        >
          <div className={styles.itemLeft}>
            {hasChildren ? (
              <button className={styles.expandBtn} onClick={(e) => toggleExpand(e, path)}>
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            ) : (
              <div className={styles.expandSpacer} />
            )}
            
            <div className={`${styles.statusDot} ${getStatusColor(item as FolderTreeItem)}`} />
            
            <Folder size={14} className={`${styles.folderIcon} ${isSelected ? styles.iconActive : ''}`} />
            
            <div className={styles.itemMeta}>
              <div className={styles.nameRow}>
                <span className={styles.itemName}>{item.name}</span>
              </div>
              {item.camera && (
                <div className={styles.cameraRow}>
                  <Camera size={10} />
                  <span>{item.camera}</span>
                </div>
              )}
            </div>
          </div>

          <div className={styles.itemRight}>
            <div className={styles.badges}>
              {hasRaw && <span className={`${styles.badge} ${styles.badgeRaw}`}>RAW</span>}
              {hasJpg && <span className={`${styles.badge} ${styles.badgeJpg}`}>JPG</span>}
              {hasHeic && <span className={`${styles.badge} ${styles.badgeHeic}`}>HEIC</span>}
              {hasVideo && <span className={`${styles.badge} ${styles.badgeMov}`}>MOV</span>}
            </div>
            <span className={styles.fileCount}>
              {new Intl.NumberFormat('pt-BR').format(item.total_files)}
            </span>
          </div>
        </div>

        {isExpanded && hasChildren && (
          <div className={styles.treeChildren}>
            {(item as any).children.map((child: FolderTreeItem) => renderItem(child))}
          </div>
        )}
      </div>
    );
  };

  if (loading && !tree) {
    return (
      <div className={styles.loadingState}>
        <LoaderCircle size={16} className="spin" />
        <span>Lendo estrutura...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.errorState}>
        <AlertCircle size={14} />
        <span>{error}</span>
        <button onClick={() => fetchTree(rootPath)} className={styles.retryBtn}>Tentar novamente</button>
      </div>
    );
  }

  return (
    <div className={styles.treeContainer}>
      {tree ? renderItem(tree, true) : (
        <div className={styles.emptyState}>
          <Search size={24} opacity={0.2} />
          <p>Nenhuma pasta selecionada</p>
        </div>
      )}
    </div>
  );
};

export default FolderTree;
