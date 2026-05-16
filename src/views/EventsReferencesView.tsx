import { useState, useEffect, useCallback } from 'react';
import { FolderTree, Folder, Check, X, Save, Scan, ChevronRight, ChevronDown, Image, RefreshCw, AlertCircle } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import styles from './EventsReferencesView.module.css';

interface FolderNode {
  name: string;
  path: string;
  status: 'include' | 'ignore' | 'monitor';
  expanded: boolean;
  photoCount: number;
  children: FolderNode[];
}

const FolderRow = ({
  node,
  depth,
  onToggle,
  onStatusChange,
  onSelect,
  selectedPath,
}: {
  node: FolderNode;
  depth: number;
  onToggle: (path: string) => void;
  onStatusChange: (path: string, status: 'include' | 'ignore' | 'monitor') => void;
  onSelect: (path: string) => void;
  selectedPath: string | null;
}) => {
  return (
    <div>
      <div
        className={`${styles.treeRow} ${selectedPath === node.path ? styles.treeRowSelected : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        <button className={styles.treeChevron} onClick={() => onToggle(node.path)}>
          {node.children.length > 0 ? (
            node.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
          ) : <span style={{ width: 12 }} />}
        </button>
        <button className={styles.treeName} onClick={() => onSelect(node.path)}>
          <Folder size={14} className={styles.treeFolderIcon} />
          <span>{node.name}</span>
          {node.photoCount > 0 && <span className={styles.treeCount}>{node.photoCount} fotos</span>}
        </button>
        <div className={styles.treeActions}>
          <button
            className={`${styles.statusBtn} ${node.status === 'include' ? styles.statusInclude : ''}`}
            onClick={(e) => { e.stopPropagation(); onStatusChange(node.path, 'include'); }}
            title="Incluir"
          >
            <Check size={12} />
          </button>
          <button
            className={`${styles.statusBtn} ${node.status === 'ignore' ? styles.statusIgnore : ''}`}
            onClick={(e) => { e.stopPropagation(); onStatusChange(node.path, 'ignore'); }}
            title="Ignorar"
          >
            <X size={12} />
          </button>
          <button
            className={`${styles.statusBtn} ${node.status === 'monitor' ? styles.statusMonitor : ''}`}
            onClick={(e) => { e.stopPropagation(); onStatusChange(node.path, 'monitor'); }}
            title="Monitorar/Verificar"
          >
            <AlertCircle size={12} />
          </button>
        </div>
      </div>
      {node.expanded && node.children.map((child) => (
        <FolderRow
          key={child.path}
          node={child}
          depth={depth + 1}
          onToggle={onToggle}
          onStatusChange={onStatusChange}
          onSelect={onSelect}
          selectedPath={selectedPath}
        />
      ))}
    </div>
  );
};

export default function EventsReferencesView() {
  const { currentCatalog, navigate } = useApp();
  const [rootPath, setRootPath] = useState('');
  const [treeData, setTreeData] = useState<FolderNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const buildTree = useCallback((folders: { path: string; name: string }[], selected: Record<string, 'include' | 'ignore' | 'monitor'>): FolderNode[] => {
    const map = new Map<string, FolderNode>();
    const roots: FolderNode[] = [];

    folders.forEach(f => {
      const parts = f.path.replace(/\\/g, '/').split('/');
      let currentPath = '';
      parts.forEach((part, i) => {
        const parentPath = currentPath;
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (!map.has(currentPath)) {
          const node: FolderNode = {
            name: part,
            path: currentPath,
            status: selected[currentPath] || 'include',
            expanded: i < 2,
            photoCount: 0,
            children: [],
          };
          map.set(currentPath, node);
          if (i === 0) {
            roots.push(node);
          } else {
            const parent = map.get(parentPath);
            if (parent) parent.children.push(node);
          }
        }
      });
    });

    const countPhotos = (node: FolderNode): number => {
      let total = node.photoCount;
      node.children.forEach(c => { total += countPhotos(c); });
      node.photoCount = total;
      return total;
    };
    roots.forEach(countPhotos);

    return roots;
  }, []);

  const loadFolderStructure = useCallback(async () => {
    if (!currentCatalog) return;
    setLoading(true);
    setError('');
    try {
      const settings = await api.getCatalogSettings(currentCatalog);
      const basePath = settings?.root_path || '';
      setRootPath(basePath);

      if (!basePath) {
        setLoading(false);
        return;
      }

      const tree = await api.exploreTree(basePath, 3);
      const allFolders: { path: string; name: string }[] = [];

      const flatten = (nodes: { name: string; path: string; children?: any[] }[], parentPath = '') => {
        nodes.forEach(n => {
          const fullPath = parentPath ? `${parentPath}/${n.name}` : n.name;
          allFolders.push({ path: fullPath, name: n.name });
          if (n.children) flatten(n.children, fullPath);
        });
      };
      if (tree.tree) flatten(Array.isArray(tree.tree) ? tree.tree : [tree.tree]);

      const savedSelected = settings?.selected_folders || {};
      setTreeData(buildTree(allFolders, savedSelected));
    } catch {
      setError('Erro ao carregar estrutura de pastas.');
    } finally {
      setLoading(false);
    }
  }, [currentCatalog, buildTree]);

  useEffect(() => {
    loadFolderStructure();
  }, [loadFolderStructure]);

  const updateStatus = (path: string, status: 'include' | 'ignore' | 'monitor') => {
    const update = (nodes: FolderNode[]): FolderNode[] =>
      nodes.map(n => ({
        ...n,
        status: n.path === path ? status : n.status,
        children: update(n.children),
      }));
    setTreeData(prev => update(prev));
  };

  const toggleExpand = (path: string) => {
    const toggle = (nodes: FolderNode[]): FolderNode[] =>
      nodes.map(n => ({
        ...n,
        expanded: n.path === path ? !n.expanded : n.expanded,
        children: toggle(n.children),
      }));
    setTreeData(prev => toggle(prev));
  };

  const flatFolders = (nodes: FolderNode[]): FolderNode[] =>
    nodes.flatMap(n => [n, ...flatFolders(n.children)]);

  const allNodes = flatFolders(treeData);
  const selectedNode = allNodes.find(n => n.path === selectedPath) || null;
  const totalFolders = allNodes.length;
  const includedCount = allNodes.filter(n => n.status === 'include').length;
  const ignoredCount = allNodes.filter(n => n.status === 'ignore').length;
  const monitoredCount = allNodes.filter(n => n.status === 'monitor').length;
  const totalPhotos = allNodes.reduce((sum, n) => sum + n.photoCount, 0);

  const handleSave = async () => {
    if (!currentCatalog) return;
    setSaving(true);
    setError('');
    try {
      const selected: Record<string, 'include' | 'ignore' | 'monitor'> = {};
      allNodes.forEach(n => { selected[n.path] = n.status; });
      const settings = await api.getCatalogSettings(currentCatalog);
      await api.saveCatalogSettings(currentCatalog, {
        root_path: settings?.root_path || rootPath,
        selected_folders: selected,
      });
    } catch {
      setError('Erro ao salvar seleção.');
    } finally {
      setSaving(false);
    }
  };

  const handleApplyToScanner = async () => {
    await handleSave();
    navigate('scanner');
  };

  const handleSelectRoot = async () => {
    const res = await api.selectFolder().catch(() => null);
    if (res?.path) {
      setRootPath(res.path);
      try {
        await api.saveCatalogSettings(currentCatalog, {
          root_path: res.path,
          selected_folders: {},
        });
        await loadFolderStructure();
      } catch {
        setError('Erro ao salvar pasta base.');
      }
    }
  };

  if (!currentCatalog) {
    return (
      <div className={styles.container}>
        <div className={styles.emptyState}>
          <FolderTree size={48} className={styles.emptyIcon} />
          <h2>Eventos & Referências</h2>
          <p>Selecione um catálogo/evento para gerenciar as pastas de referência.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Eventos & Referências</h1>
        <p className={styles.subtitle}>
          Gerencie as pastas de referência do evento <strong>{currentCatalog}</strong>
        </p>
      </div>

      <div className={styles.mainLayout}>
        <div className={styles.leftPanel}>
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>Pastas</span>
            <button className={styles.toolBtn} onClick={handleSelectRoot} title="Selecionar pasta base">
              <Folder size={12} />
            </button>
            <button className={styles.toolBtn} onClick={loadFolderStructure} title="Recarregar">
              <RefreshCw size={12} />
            </button>
          </div>

          {rootPath && (
            <div className={styles.rootPath}>
              <Folder size={12} />
              <span>{rootPath}</span>
            </div>
          )}

          <div className={styles.treeContainer}>
            {loading ? (
              <div className={styles.loadingState}>Carregando estrutura...</div>
            ) : treeData.length === 0 ? (
              <div className={styles.emptyTree}>
                {rootPath ? 'Nenhuma subpasta encontrada.' : 'Selecione uma pasta base primeiro.'}
              </div>
            ) : (
              treeData.map(node => (
                <FolderRow
                  key={node.path}
                  node={node}
                  depth={0}
                  onToggle={toggleExpand}
                  onStatusChange={updateStatus}
                  onSelect={setSelectedPath}
                  selectedPath={selectedPath}
                />
              ))
            )}
          </div>
        </div>

        <div className={styles.rightPanel}>
          {selectedNode ? (
            <div className={styles.detailPanel}>
              <h3 className={styles.detailTitle}>{selectedNode.name}</h3>
              <div className={styles.detailInfo}>
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>Caminho:</span>
                  <span className={styles.detailValue}>{selectedNode.path}</span>
                </div>
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>Status:</span>
                  <span className={`${styles.detailStatus} ${
                    selectedNode.status === 'include' ? styles.statusIncludeText :
                    selectedNode.status === 'ignore' ? styles.statusIgnoreText :
                    styles.statusMonitorText
                  }`}>
                    {selectedNode.status === 'include' ? 'Incluir' :
                     selectedNode.status === 'ignore' ? 'Ignorar' : 'Monitorar'}
                  </span>
                </div>
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>Fotos:</span>
                  <span className={styles.detailValue}>{selectedNode.photoCount}</span>
                </div>
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>Subpastas:</span>
                  <span className={styles.detailValue}>{selectedNode.children.length}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className={styles.detailEmpty}>
              <Image size={32} className={styles.detailEmptyIcon} />
              <p>Selecione uma pasta para ver detalhes</p>
            </div>
          )}

          <div className={styles.summaryPanel}>
            <h3 className={styles.panelTitle}>Resumo</h3>
            <div className={styles.summaryGrid}>
              <div className={styles.summaryItem}>
                <span className={styles.summaryValue}>{totalFolders}</span>
                <span className={styles.summaryLabel}>Pastas</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryValue} style={{ color: '#34d399' }}>{includedCount}</span>
                <span className={styles.summaryLabel}>Incluir</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryValue} style={{ color: '#f87171' }}>{ignoredCount}</span>
                <span className={styles.summaryLabel}>Ignorar</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryValue} style={{ color: '#fbbf24' }}>{monitoredCount}</span>
                <span className={styles.summaryLabel}>Monitorar</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryValue}>{totalPhotos}</span>
                <span className={styles.summaryLabel}>Total Fotos</span>
              </div>
            </div>
          </div>

          <div className={styles.actionsPanel}>
            <button className={styles.saveBtn} onClick={handleSave} disabled={saving}>
              <Save size={14} />
              {saving ? 'Salvando...' : 'Salvar Seleção'}
            </button>
            <button className={styles.applyBtn} onClick={handleApplyToScanner}>
              <Scan size={14} />
              Aplicar ao Scanner
            </button>
          </div>

          {error && <div className={styles.error}>{error}</div>}
        </div>
      </div>
    </div>
  );
}
