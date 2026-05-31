import { useState, useEffect, useCallback } from 'react';
import { api, catalogApi } from '../services/api';
import { useApp } from '../context/AppContext';

interface FolderInfo {
  photos: number;
  subfolders: number;
}

interface SubfolderItem {
  name: string;
  path: string;
  totalFiles: number;
}

export function useScannerFolders(setError: (err: string) => void) {
  const { currentCatalog } = useApp();

  const [eventPath, setEventPath] = useState('');
  const [refPath, setRefPath] = useState('');
  const [refPathInfo, setRefPathInfo] = useState<FolderInfo | null>(null);
  const [eventPathInfo, setEventPathInfo] = useState<FolderInfo | null>(null);

  // Subpastas de eventos selecionadas granularmente
  const [eventSubfolders, setEventSubfolders] = useState<SubfolderItem[]>([]);
  const [selectedSubfolders, setSelectedSubfolders] = useState<string[]>([]);
  const [loadingSubfolders, setLoadingSubfolders] = useState(false);

  const [eventFolders, setEventFolders] = useState<string[]>([]);
  const [eventPhotosCount, setEventPhotosCount] = useState(0);
  const [eventPhotosCountStatus, setEventPhotosCountStatus] = useState<'none' | 'loading' | 'done' | 'error'>('none');

  // Carrega subpastas físicas imediatas da pasta de eventos selecionada
  useEffect(() => {
    if (eventPath) {
      setLoadingSubfolders(true);
      api.exploreTree(eventPath, 1)
        .then(res => {
          if (res && res.ok && Array.isArray(res.children)) {
            const subs = res.children
              .filter((c: any) => c.type === 'folder')
              .map((c: any) => ({
                name: c.name,
                path: c.path,
                totalFiles: c.total_files || 0
              }));
            setEventSubfolders(subs);
            setSelectedSubfolders(subs.map(s => s.path));
            
            const totalPhotos = res.total_photos || res.total_files || 0;
            const subfoldersCount = subs.length;
            setEventPathInfo({ photos: totalPhotos, subfolders: subfoldersCount });
          } else {
            setEventSubfolders([]);
            setSelectedSubfolders([]);
            setEventPathInfo(null);
          }
        })
        .catch(() => {
          setEventSubfolders([]);
          setSelectedSubfolders([]);
          setEventPathInfo(null);
        })
        .finally(() => {
          setLoadingSubfolders(false);
        });
    } else {
      setEventSubfolders([]);
      setSelectedSubfolders([]);
      setEventPathInfo(null);
    }
  }, [eventPath]);

  // Sincroniza o nome do catálogo inicial e carrega as pastas já vinculadas do catálogo
  useEffect(() => {
    if (currentCatalog) {
      catalogApi.listFolders(currentCatalog)
        .then(res => {
          const folders = res.folders || [];
          if (Array.isArray(folders)) {
            const eventFolder = folders.find(f => f.folder_type === 'event' || f.folderType === 'event');
            const refFolder = folders.find(f => f.folder_type === 'reference' || f.folderType === 'reference');
            
            if (eventFolder?.path) {
              setEventPath(eventFolder.path);
              setEventFolders(prev => {
                if (!prev.includes(eventFolder.path)) {
                  return [...prev, eventFolder.path];
                }
                return prev;
              });
            }
            if (refFolder?.path) {
              setRefPath(refFolder.path);
              Promise.all([
                api.explorePhotos(refFolder.path, { recursive: true, limit: 0, include_raw: true }),
                api.exploreTree(refFolder.path, 1)
              ]).then(([photosRes, treeRes]) => {
                const subCount = treeRes && treeRes.ok && Array.isArray(treeRes.children)
                  ? treeRes.children.filter((c: any) => c.type === 'folder').length
                  : 0;
                setRefPathInfo({
                  photos: photosRes.total || 0,
                  subfolders: subCount,
                });
              }).catch(() => {
                api.explorePhotos(refFolder.path, { recursive: true, limit: 0, include_raw: true })
                  .then(photosRes => {
                    setRefPathInfo({
                      photos: photosRes.total || 0,
                      subfolders: 0,
                    });
                  }).catch(() => null);
              });
            }
          }
        })
        .catch(err => {
          console.warn('[useScannerFolders] falha ao carregar pastas salvas:', err);
        });
    }
  }, [currentCatalog]);

  // Efeito de contagem recursiva de fotos totais do evento
  useEffect(() => {
    if (eventFolders.length === 0) {
      setEventPhotosCount(0);
      setEventPhotosCountStatus('none');
      return;
    }
    const fetchInfo = async () => {
      setEventPhotosCountStatus('loading');
      try {
        let total = 0;
        for (const path of eventFolders) {
          const res = await api.explorePhotos(path, { 
            recursive: true, 
            limit: 0, 
            include_raw: true 
          });
          total += res.total || 0;
        }
        setEventPhotosCount(total);
        setEventPhotosCountStatus('done');
      } catch (e) {
        console.error('Erro ao contar fotos de eventos:', e);
        setEventPhotosCountStatus('error');
      }
    };
    fetchInfo();
  }, [eventFolders]);

  const handlePickRef = useCallback(async () => {
    const res = await api.selectFolder().catch(() => null);
    if (res?.path) {
      setRefPath(res.path);
      try {
        const [photos, tree] = await Promise.all([
          api.explorePhotos(res.path, { recursive: true, limit: 0, include_raw: true }),
          api.exploreTree(res.path, 1),
        ]);
        const subfolderCount = tree && tree.ok && Array.isArray(tree.children)
          ? tree.children.filter((c: any) => c.type === 'folder').length
          : 0;
        setRefPathInfo({
          photos: photos.total || 0,
          subfolders: subfolderCount,
        });
      } catch {
        setError('Erro ao carregar estatísticas da pasta de referência.');
      }
    }
  }, [setError]);

  const handleAddEventFolder = useCallback(async () => {
    const res = await api.selectFolder().catch(() => null);
    if (res?.path) {
      setEventPath(res.path);
      setEventFolders(prev => {
        if (!prev.includes(res.path)) {
          return [...prev, res.path];
        }
        return prev;
      });
      
      // Tentar autodetectar pasta de referência
      try {
        const tree = await api.exploreTree(res.path, 1).catch(() => null);
        const children = tree?.children ?? [];
        
        const REF_CANDIDATE_NAMES = ['Referências', 'Referencia', 'Referencias', 'Referência', 'Fotos_Referencia', 'Fotos_Referencias', 'FOTOS_REFERENCIA', 'FOTOS_REFERENCIAS', 'referencia', 'referencias'];
        const foundChild = children.find((c: { name: string; path: string }) => 
          REF_CANDIDATE_NAMES.some(cand => cand.toLowerCase() === c.name.toLowerCase())
        );
        
        if (foundChild) {
          setRefPath(foundChild.path);
          const [photos, childTree] = await Promise.all([
            api.explorePhotos(foundChild.path, { recursive: true, limit: 0, include_raw: true }).catch(() => null),
            api.exploreTree(foundChild.path, 1).catch(() => null)
          ]);
          const subCount = childTree && childTree.ok && Array.isArray(childTree.children)
            ? childTree.children.filter((c: any) => c.type === 'folder').length
            : 0;
          setRefPathInfo({
            photos: photos?.total || 0,
            subfolders: subCount,
          });
        }
      } catch (err) {
        console.error('[AutodetectRef] Falha:', err);
      }
    }
  }, []);

  return {
    eventPath,
    setEventPath,
    refPath,
    setRefPath,
    refPathInfo,
    setRefPathInfo,
    eventPathInfo,
    setEventPathInfo,
    eventSubfolders,
    selectedSubfolders,
    setSelectedSubfolders,
    loadingSubfolders,
    eventFolders,
    eventPhotosCount,
    eventPhotosCountStatus,
    handlePickRef,
    handleAddEventFolder,
  };
}
