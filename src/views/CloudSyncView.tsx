import { useState } from 'react';
import { cloudApi } from '../services/cloudApi';
import styles from './CloudSyncView.module.css';

interface CloudProvider {
  id: string;
  name: string;
  icon: string;
  connected: boolean;
  lastSync?: string;
}

interface SyncStatus {
  is_online: boolean;
  pending_uploads: number;
  pending_downloads: number;
  last_sync?: string;
  sync_progress: number;
}

export default function CloudSyncView() {
  const [providers] = useState<CloudProvider[]>([
    { id: 'google-drive', name: 'Google Drive', icon: '🎯', connected: false },
    { id: 'dropbox', name: 'Dropbox', icon: '📦', connected: false },
    { id: 'onedrive', name: 'OneDrive', icon: '☁️', connected: false },
  ]);

  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

  const handleProviderSelect = (providerId: string) => {
    setSelectedProvider(selectedProvider === providerId ? null : providerId);
  };
  const [syncStatus] = useState<SyncStatus>({
    is_online: true,
    pending_uploads: 0,
    pending_downloads: 0,
    sync_progress: 1,
  });

  const handleConnect = async (providerId: string) => {
    try {
      const result = await cloudApi.getAuthUrl(providerId);
      if (result.auth_url) {
        window.open(result.auth_url, '_blank', 'width=600,height=700');
      }
    } catch (e) {
      console.error('Erro ao conectar:', e);
    }
  };

  const handleDisconnect = async (providerId: string) => {
    try {
      await cloudApi.disconnect(providerId);
    } catch (e) {
      console.error('Erro ao desconectar:', e);
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
        {syncStatus.last_sync && (
          <span className={styles.lastSync}>
            Última sincronização: {syncStatus.last_sync}
          </span>
        )}
      </div>

      <section className={styles.providersSection}>
        <h2>Provedores</h2>
        <div className={styles.providersGrid}>
          {providers.map((provider) => (
            <div
              key={provider.id}
              className={styles.providerCard}
              onClick={() => handleProviderSelect(provider.id)}
              style={{ cursor: 'pointer' }}
            >
              <div className={styles.providerIcon}>{provider.icon}</div>
              <div className={styles.providerInfo}>
                <h3>{provider.name}</h3>
                <span className={styles.providerStatus}>
                  {provider.connected ? 'Conectado' : 'Não conectado'}
                </span>
              </div>
              <button
                className={`${styles.connectBtn} ${provider.connected ? styles.disconnect : ''}`}
                onClick={() => provider.connected ? handleDisconnect(provider.id) : handleConnect(provider.id)}
              >
                {provider.connected ? 'Desconectar' : 'Conectar'}
              </button>
            </div>
          ))}
        </div>
      </section>

      {selectedProvider && (
        <section className={styles.foldersSection}>
          <h2>Pasta do Google Drive</h2>
          <div className={styles.folderSelector}>
            <p className={styles.placeholder}>
              Selecione uma pasta para sincronizar...
            </p>
          </div>
        </section>
      )}

      <section className={styles.syncSection}>
        <h2>Sincronização</h2>
        <div className={styles.syncActions}>
          <button className={styles.syncBtn} disabled={!selectedProvider}>
            Sincronizar agora
          </button>
          <button className={styles.settingsBtn}>
            Configurações de sync
          </button>
        </div>
      </section>
    </div>
  );
}