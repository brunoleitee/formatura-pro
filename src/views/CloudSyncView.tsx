import { useState, useEffect, useCallback, useRef } from 'react';
import { cloudApi } from '../services/cloudApi';
import styles from './CloudSyncView.module.css';

interface CloudProvider {
  id: string;
  name: string;
  icon: string;
}

interface SyncStatus {
  is_online: boolean;
}

interface Folder {
  id: string;
  name: string;
  parent?: string;
}

interface CloudFile {
  drive_file_id: string;
  name: string;
  mime_type: string;
  modified_time?: string;
  size?: number;
  has_thumb?: boolean;
  has_preview?: boolean;
  has_full?: boolean;
}

export default function CloudSyncView() {
  const [providers] = useState<CloudProvider[]>([
    { id: 'google-drive', name: 'Google Drive', icon: '🎯' },
    { id: 'dropbox', name: 'Dropbox', icon: '📦' },
    { id: 'onedrive', name: 'OneDrive', icon: '☁️' },
  ]);

  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [connectedProvider, setConnectedProvider] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string>('root');
  const [syncStatus] = useState<SyncStatus>({ is_online: true });
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCatalogName, setNewCatalogName] = useState('');
  const [createResult, setCreateResult] = useState<{ status: string; message: string } | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedFolderName, setSelectedFolderName] = useState<string>('');
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexCount, setIndexCount] = useState<number | null>(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [loadedThumbs, setLoadedThumbs] = useState<Set<string>>(new Set());
  const [showExplorer, setShowExplorer] = useState(false);
  const pollingRef = useRef<number | null>(null);
  const [thumbTick, setThumbTick] = useState(0);
  const [openingFileId, setOpeningFileId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<{ fileId: string; url: string; name: string } | null>(null);

  const loadFolders = useCallback(async (parentId: string = 'root') => {
    setLoading(true);
    try {
      const result = await cloudApi.getGoogleFolders(parentId);
      setFolders(result.folders || []);
      setCurrentFolder(parentId);
    } catch (e) {
      console.error('Erro ao carregar pastas:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const checkGoogleStatus = useCallback(async () => {
    try {
      const status = await cloudApi.getGoogleStatus();
      if (status.connected) {
        setConnectedProvider('google-drive');
        setUserEmail(status.email || '');
        setSelectedProvider('google-drive');
        setShowExplorer(true);
        loadFolders('root');
        return true;
      }
      return false;
    } catch (e) {
      console.error('Erro ao verificar status:', e);
      return false;
    }
  }, [loadFolders]);

  useEffect(() => {
    checkGoogleStatus();
  }, [checkGoogleStatus]);

  const startPolling = useCallback(() => {
    let attempts = 0;
    const poll = async () => {
      attempts++;
      const ok = await checkGoogleStatus();
      if (!ok && attempts < 15) {
        pollingRef.current = window.setTimeout(poll, 2000);
      }
    };
    poll();
  }, [checkGoogleStatus]);

  useEffect(() => {
    return () => {
      if (pollingRef.current !== null) {
        clearTimeout(pollingRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (indexCount !== null && files.length > 0) {
      const timer = setInterval(() => {
        setLoadedThumbs(prev => {
          const next = new Set(prev);
          for (const f of files) {
            if (!next.has(f.drive_file_id)) {
              next.add(f.drive_file_id);
              return next;
            }
          }
          clearInterval(timer);
          return prev;
        });
      }, 300);
      return () => clearInterval(timer);
    }
  }, [indexCount, files]);

  useEffect(() => {
    if (indexCount === null || files.length === 0) return;
    const timer = setInterval(() => setThumbTick(t => t + 1), 3000);
    return () => clearInterval(timer);
  }, [indexCount, files]);

  const handleConnect = async (providerId: string) => {
    if (providerId !== 'google-drive') {
      alert('Apenas Google Drive disponível nesta versão');
      return;
    }
    setLoading(true);
    try {
      const result = await cloudApi.getGoogleAuthUrl();
      if (result.auth_url) {
        window.open(result.auth_url, '_blank', 'width=600,height=700');
        startPolling();
      } else if (result.error) {
        alert(result.error);
      }
    } catch (e) {
      console.error('Erro ao conectar:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async (providerId: string) => {
    if (providerId !== 'google-drive') return;
    setLoading(true);
    try {
      await cloudApi.googleLogout();
      setConnectedProvider(null);
      setUserEmail('');
      setFolders([]);
      setFiles([]);
      setSelectedFolderId(null);
      setSelectedFolderName('');
      setIndexCount(null);
      setLoadedThumbs(new Set());
      setShowExplorer(false);
      setSelectedProvider(null);
    } catch (e) {
      console.error('Erro ao desconectar:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectFolder = (folderId: string, folderName: string) => {
    setSelectedFolderId(folderId);
    setSelectedFolderName(folderName);
    setCurrentFolder(folderId);
    setIndexCount(null);
    setFiles([]);
    setLoadedThumbs(new Set());
  };

  const handleIndex = async () => {
    if (!selectedFolderId) return;
    setIsIndexing(true);
    setIndexCount(null);
    try {
      const result = await cloudApi.indexFolder(selectedFolderId);
      if (!result.error) {
        setIndexCount(result.count || 0);
        setIsLoadingFiles(true);
        const filesResult = await cloudApi.getFiles(selectedFolderId);
        setFiles(filesResult.files as CloudFile[] || []);
        setIsLoadingFiles(false);
      } else {
        console.error('Erro ao indexar:', result.error);
      }
    } catch (e) {
      console.error('Erro ao indexar pasta:', e);
    } finally {
      setIsIndexing(false);
    }
  };

  const handleRefresh = async () => {
    if (!selectedFolderId) return;
    setIsLoadingFiles(true);
    try {
      const filesResult = await cloudApi.getFiles(selectedFolderId);
      setFiles(filesResult.files as CloudFile[] || []);
    } catch (e) {
      console.error('Erro ao recarregar:', e);
    } finally {
      setIsLoadingFiles(false);
    }
  };

  const handleNavigateFolder = (folderId: string) => {
    setCurrentFolder(folderId);
    setSelectedFolderId(null);
    setSelectedFolderName('');
    setFiles([]);
    setIndexCount(null);
    loadFolders(folderId);
  };

  const handleOpenFile = useCallback(async (file: CloudFile) => {
    console.log("[CloudOpen] opening file_id:", file.drive_file_id);
    setOpeningFileId(file.drive_file_id);
    try {
      const result = await cloudApi.downloadFull(file.drive_file_id);
      if (result.success && result.url) {
        console.log("[CloudOpen] downloaded full:", result.url);
        setPreviewFile({ fileId: file.drive_file_id, url: result.url, name: file.name });
      } else if (result.status === "downloading") {
        // Poll until ready
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const poll = await cloudApi.downloadFull(file.drive_file_id);
          if (poll.success && poll.url) {
            console.log("[CloudOpen] downloaded full (poll):", poll.url);
            setPreviewFile({ fileId: file.drive_file_id, url: poll.url, name: file.name });
            break;
          }
          if (poll.error) {
            console.error("[CloudOpen] error:", poll.error);
            break;
          }
        }
      } else if (result.error) {
        console.error("[CloudOpen] error:", result.error);
      }
    } catch (e) {
      console.error("[CloudOpen] erro ao abrir:", e);
    } finally {
      setOpeningFileId(null);
    }
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1>Nuvem</h1>
        <p>Sincronize suas fotos com serviços de armazenamento na nuvem</p>
      </div>

      <div className={styles.statusBar}>
        <div className={styles.statusIndicator} data-online={syncStatus.is_online}>
          <span className={styles.statusDot}></span>
          <span>{syncStatus.is_online ? 'Online' : 'Offline'}</span>
        </div>
        {connectedProvider === 'google-drive' && userEmail && (
          <span className={styles.lastSync}>Conectado: {userEmail}</span>
        )}
        {connectedProvider === 'google-drive' && !userEmail && (
          <span className={styles.lastSync}>Google Drive conectado</span>
        )}
      </div>

      <section className={styles.providersSection}>
        <h2>Provedores</h2>
        <div className={styles.providersGrid}>
          {providers.map((provider) => (
            <div
              key={provider.id}
              className={`${styles.providerCard} ${selectedProvider === provider.id ? styles.selected : ''}`}
              onClick={() => {
                if (connectedProvider === provider.id) {
                  setShowExplorer(v => !v);
                  if (!showExplorer) loadFolders('root');
                }
              }}
            >
              <div className={styles.providerIcon}>{provider.icon}</div>
              <div className={styles.providerInfo}>
                <h3>{provider.name}</h3>
                <span className={styles.providerStatus}>
                  {connectedProvider === provider.id ? 'Conectado' : 'Não conectado'}
                </span>
              </div>
              <button
                className={`${styles.connectBtn} ${connectedProvider === provider.id ? styles.disconnect : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  connectedProvider === provider.id ? handleDisconnect(provider.id) : handleConnect(provider.id);
                }}
                disabled={loading}
              >
                {loading ? '...' : connectedProvider === provider.id ? 'Desconectar' : 'Conectar'}
              </button>
            </div>
          ))}
        </div>
      </section>

      {showExplorer && connectedProvider === 'google-drive' && (
        <section className={styles.foldersSection}>
          <div className={styles.folderSectionHeader}>
            <h2>Google Drive Explorer</h2>
          </div>

          {loading && !folders.length ? (
            <div className={styles.folderSelector}>
              <p className={styles.placeholder}>Carregando pastas...</p>
            </div>
          ) : files.length > 0 || indexCount !== null ? (
            <>
              <div className={styles.breadcrumb}>
                <button onClick={() => handleNavigateFolder('root')}>Raiz</button>
                {selectedFolderName && <span> / {selectedFolderName}</span>}
              </div>

              {indexCount !== null && (
                <div className={styles.indexResult}>
                  <span>{indexCount} arquivos indexados</span>
                  <button className={styles.refreshBtn} onClick={handleRefresh} disabled={isLoadingFiles}>
                    {isLoadingFiles ? '...' : 'Recarregar'}
                  </button>
                </div>
              )}

              {isLoadingFiles ? (
                <div className={styles.folderSelector}>
                  <p className={styles.placeholder}>Carregando arquivos...</p>
                </div>
              ) : files.length > 0 ? (
                <div className={styles.filesGrid}>
                  {files.map((file) => (
                    <div
                      key={file.drive_file_id}
                      className={styles.fileCard}
                      onClick={() => handleOpenFile(file)}
                    >
                      <div className={styles.fileThumb}>
                        {loadedThumbs.has(file.drive_file_id) ? (
                          <img
                            src={`/api/cloud/thumb?file_id=${file.drive_file_id}&_t=${thumbTick}`}
                            alt={file.name}
                            loading="lazy"
                            decoding="async"
                          />
                        ) : (
                          <div className={styles.filePlaceholder}>📷</div>
                        )}
                        {openingFileId === file.drive_file_id && (
                          <div className={styles.fileLoadingOverlay}>
                            <span className={styles.fileLoadingSpinner}></span>
                          </div>
                        )}
                        <div className={styles.cloudBadge}>☁️</div>
                      </div>
                      <div className={styles.fileInfo}>
                        <span className={styles.fileName}>{file.name}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : indexCount !== null ? (
                <div className={styles.folderSelector}>
                  <p className={styles.placeholder}>Nenhum arquivo encontrado.</p>
                </div>
              ) : null}

              {files.length > 0 && (
                <div className={styles.createCatalogSection}>
                  <button
                    className={styles.createCatalogBtn}
                    onClick={() => setShowCreateModal(true)}
                  >
                    Criar catálogo a partir desta pasta
                  </button>
                </div>
              )}
            </>
          ) : folders.length > 0 ? (
            <div className={styles.explorerContainer}>
              <div className={styles.explorerHeader}>
                <span className={styles.explorerTitle}>
                  {currentFolder === 'root' ? 'Raiz' : selectedFolderName}
                </span>
                <button
                  className={styles.explorerRefresh}
                  onClick={() => handleNavigateFolder(currentFolder)}
                >
                  🔄 Atualizar
                </button>
              </div>
              <div className={styles.explorerBody}>
                <div className={styles.folderGrid}>
                  {currentFolder !== 'root' && (
                    <div className={styles.folderCard} onClick={() => handleNavigateFolder('root')}>
                      <span className={styles.folderCardIcon}>⬆️</span>
                      <span className={styles.folderCardName}>Voltar (Raiz)</span>
                    </div>
                  )}
                  {folders.map((folder) => (
                    <div
                      key={folder.id}
                      className={`${styles.folderCard} ${selectedFolderId === folder.id ? styles.folderCardSelected : ''}`}
                      onClick={() => handleSelectFolder(folder.id, folder.name)}
                    >
                      <span className={styles.folderCardIcon}>📁</span>
                      <span className={styles.folderCardName}>{folder.name}</span>
                      {selectedFolderId === folder.id && (
                        <span className={styles.folderCardBadge}>Selecionado</span>
                      )}
                    </div>
                  ))}
                </div>

                {selectedFolderId && (
                  <div className={styles.indexActions}>
                    <button
                      className={styles.indexBtn}
                      onClick={handleIndex}
                      disabled={isIndexing}
                    >
                      {isIndexing ? (
                        <span className={styles.indexingContent}>
                          <span className={styles.spinner}></span>
                          Indexando...
                        </span>
                      ) : (
                        `Indexar "${selectedFolderName}"`
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className={styles.folderSelector}>
              <p className={styles.placeholder}>Nenhuma pasta encontrada.</p>
              <button className={styles.refreshBtn} onClick={() => handleNavigateFolder('root')}>
                Recarregar pastas
              </button>
            </div>
          )}
        </section>
      )}

      {showCreateModal && (
        <div className={styles.modal}>
          <div className={styles.modalContent}>
            <h3>Criar Catálogo</h3>
            <p>Digite o nome do novo catálogo:</p>
            <input
              type="text"
              value={newCatalogName}
              onChange={(e) => setNewCatalogName(e.target.value)}
              placeholder="Nome do catálogo"
              className={styles.modalInput}
            />
            <div className={styles.modalActions}>
              <button
                className={styles.cancelBtn}
                onClick={() => {
                  setShowCreateModal(false);
                  setNewCatalogName('');
                }}
              >
                Cancelar
              </button>
              <button
                className={styles.confirmBtn}
                onClick={async () => {
                  if (!newCatalogName.trim()) {
                    alert('Digite um nome para o catálogo');
                    return;
                  }
                  setLoading(true);
                  try {
                    const result = await cloudApi.createCatalog(currentFolder, newCatalogName);
                    if (result.status === 'ok') {
                      setCreateResult({ status: 'success', message: `Catálogo "${result.catalog}" criado com ${result.photos_count} fotos!` });
                      setShowCreateModal(false);
                    } else {
                      alert(result.error || 'Erro ao criar catálogo');
                    }
                  } catch (e) {
                    console.error('Erro:', e);
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                Criar
              </button>
            </div>
          </div>
        </div>
      )}

      {createResult && (
        <div className={styles.toast}>
          <span>{createResult.message}</span>
          <button onClick={() => setCreateResult(null)}>×</button>
        </div>
      )}

      {previewFile && (
        <div className={styles.viewerOverlay} onClick={() => setPreviewFile(null)}>
          <div className={styles.viewerContent} onClick={e => e.stopPropagation()}>
            <div className={styles.viewerHeader}>
              <span className={styles.viewerFilename}>{previewFile.name}</span>
              <button className={styles.viewerClose} onClick={() => setPreviewFile(null)}>×</button>
            </div>
            <div className={styles.viewerBody}>
              <img
                src={previewFile.url}
                alt={previewFile.name}
                className={styles.viewerImage}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
