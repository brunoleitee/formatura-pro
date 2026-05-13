import { useState, useEffect } from 'react';
import { cloudApi } from '../services/cloudApi';
import styles from './CloudSyncView.module.css';

interface CloudProvider {
  id: string;
  name: string;
  icon: string;
}

interface SyncStatus {
  is_online: boolean;
  pending_uploads: number;
  pending_downloads: number;
  last_sync?: string;
  sync_progress: number;
}

interface Folder {
  id: string;
  name: string;
  parent?: string;
  modifiedTime?: string;
}

export default function CloudSyncView() {
  const [providers] = useState<CloudProvider[]>([
    { id: 'google-drive', name: 'Google Drive', icon: '🎯' },
    { id: 'dropbox', name: 'Dropbox', icon: '📦', },
    { id: 'onedrive', name: 'OneDrive', icon: '☁️', },
  ]);

  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [connectedProvider, setConnectedProvider] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [syncStatus] = useState<SyncStatus>({
    is_online: true,
    pending_uploads: 0,
    pending_downloads: 0,
    sync_progress: 1,
  });

  useEffect(() => {
    checkGoogleStatus();
  }, []);

  const checkGoogleStatus = async () => {
    try {
      const status = await cloudApi.getGoogleStatus();
      if (status.connected) {
        setConnectedProvider('google-drive');
        setUserEmail(status.email || '');
      }
    } catch (e) {
      console.error('Erro ao verificar status:', e);
    }
  };

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
        setTimeout(checkGoogleStatus, 3000);
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
    } catch (e) {
      console.error('Erro ao desconectar:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleProviderSelect = async (providerId: string) => {
    if (providerId !== 'google-drive') return;

    if (selectedProvider === providerId) {
      setSelectedProvider(null);
      return;
    }

    setSelectedProvider(providerId);

    if (connectedProvider === 'google-drive') {
      setLoading(true);
      try {
        const result = await cloudApi.getGoogleFolders('root');
        setFolders(result.folders || []);
      } catch (e) {
        console.error('Erro ao carregar pastas:', e);
      } finally {
        setLoading(false);
      }
    }
  };

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
          <span className={styles.lastSync}>
            Conectado: {userEmail}
          </span>
        )}
      </div>

      <section className={styles.providersSection}>
        <h2>Provedores</h2>
        <div className={styles.providersGrid}>
          {providers.map((provider) => (
            <div
              key={provider.id}
              className={`${styles.providerCard} ${selectedProvider === provider.id ? styles.selected : ''}`}
              onClick={() => handleProviderSelect(provider.id)}
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

      {selectedProvider === 'google-drive' && connectedProvider === 'google-drive' && (
        <section className={styles.foldersSection}>
          <h2>Pasta do Google Drive</h2>
          {loading ? (
            <div className={styles.folderSelector}>
              <p className={styles.placeholder}>Carregando...</p>
            </div>
          ) : folders.length > 0 ? (
            <div className={styles.folderList}>
              {folders.map((folder) => (
                <div key={folder.id} className={styles.folderItem}>
                  <span>📁 {folder.name}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.folderSelector}>
              <p className={styles.placeholder}>Nenhuma pasta encontrada</p>
            </div>
          )}
        </section>
      )}

      <section className={styles.syncSection}>
        <h2>Sincronização</h2>
        <div className={styles.syncActions}>
          <button className={styles.syncBtn} disabled={!selectedProvider}>
            Sincronizar agora
          </button>
          <button className={styles.settingsBtn}>
            Configurações
          </button>
        </div>
      </section>
    </div>
  );
}