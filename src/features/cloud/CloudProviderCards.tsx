import { Cloud, Database, HardDrive, RefreshCw, Unplug } from 'lucide-react';
import type { CloudConnection, CloudProvider, CloudProviderSummary } from './types';
import styles from '../../views/CloudSettings.module.css';

type CloudProviderCardsProps = {
  providers: CloudProviderSummary[];
  connections: CloudConnection[];
  loading?: boolean;
  onConnect?: (provider: CloudProvider) => void;
  onDisconnect?: (provider: CloudProvider) => void;
  onSwitchAccount?: (provider: CloudProvider) => void;
};

const providerIcons: Record<CloudProvider, React.ReactNode> = {
  google_drive: <img src="/google-drive.svg" alt="" className={styles.providerLogo} />,
  dropbox: <Database size={24} />,
  onedrive: <Cloud size={24} />,
};

function labelForStatus(connection?: CloudConnection) {
  if (!connection || !connection.connected) return 'Desconectado';
  return connection.status === 'offline' ? 'Offline' : 'Online';
}

export function CloudProviderCards({
  providers,
  connections,
  loading = false,
  onConnect,
  onDisconnect,
  onSwitchAccount,
}: CloudProviderCardsProps) {
  return (
    <div className={styles.providersGrid}>
      {providers.map(provider => {
        const connection = connections.find(item => item.provider === provider.provider);
        const connected = Boolean(connection?.connected);
        const canUse = provider.functional;

        return (
          <article className={styles.providerCard} key={provider.provider} data-connected={connected}>
            <div className={styles.providerIcon}>{providerIcons[provider.provider]}</div>
            <div className={styles.providerBody}>
              <div className={styles.providerTitleRow}>
                <h3>{provider.name}</h3>
                {!canUse && <span className={styles.badge}>Em breve</span>}
              </div>
              <span className={styles.providerStatus}>{labelForStatus(connection)}</span>
              {connection?.accountEmail && (
                <span className={styles.providerAccount}>{connection.accountEmail}</span>
              )}
            </div>

            <div className={styles.providerActions}>
              {connected ? (
                <>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => onSwitchAccount?.(provider.provider)}
                    disabled={loading || !canUse}
                  >
                    <RefreshCw size={14} />
                    Trocar conta
                  </button>
                  <button
                    type="button"
                    className={styles.dangerButton}
                    onClick={() => onDisconnect?.(provider.provider)}
                    disabled={loading || !canUse}
                  >
                    <Unplug size={14} />
                    Desconectar
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => onConnect?.(provider.provider)}
                  disabled={loading || !canUse}
                >
                  <HardDrive size={14} />
                  Conectar
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
