import { useState } from 'react';
import { FolderOpen, Scan, X, Info, Plus } from 'lucide-react';
import { api } from '../services/api';
import { useApp } from '../context/AppContext';
import styles from './ScanModal.module.css';

interface Props {
  onClose: () => void;
  onScanStarted: (meta: { catalogName: string; oriPath: string; refPath: string }) => void;
}

export default function ScanModal({ onClose, onScanStarted }: Props) {
  const { currentCatalog, catalogs, setCatalog, refreshCatalogs } = useApp();
  const [refPath, setRefPath] = useState('');
  const [oriPath, setOriPath] = useState('');
  const [catalogName, setCatalogName] = useState(currentCatalog);
  const [newCatalogMode, setNewCatalogMode] = useState(false);
  const [newCatalogName, setNewCatalogName] = useState('');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  const pickRef = async () => {
    const res = await api.selectFolder().catch(() => null);
    if (res?.path) setRefPath(res.path);
  };

  const pickOri = async () => {
    const res = await api.selectFolder().catch(() => null);
    if (res?.path) setOriPath(res.path);
  };

  const activeCatalog = newCatalogMode ? newCatalogName.trim() : catalogName;
  const canStart = Boolean(oriPath && activeCatalog && !starting);

  const handleScan = async () => {
    if (!oriPath) {
      setError('Selecione a pasta de evento.');
      return;
    }
    if (!activeCatalog) {
      setError('Informe o nome do evento/catálogo.');
      return;
    }

    setError('');
    setStarting(true);
    try {
      await api.scanFolder(oriPath, refPath, activeCatalog);
      await setCatalog(activeCatalog);
      await refreshCatalogs();
      onScanStarted({ catalogName: activeCatalog, oriPath, refPath });
      onClose();
    } catch {
      setError('Erro ao iniciar o escaneamento. Verifique o backend.');
      setStarting(false);
    }
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="scan-modal-title">
        <div className={styles.topStrip} />

        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.iconBadge} aria-hidden="true">
              <Scan size={18} strokeWidth={2.15} />
            </div>
            <div className={styles.titleGroup}>
              <h2 id="scan-modal-title" className={styles.title}>Escanear Fotos</h2>
              <p className={styles.subtitle}>Organize as pastas e inicie o processamento em um fluxo mais elegante.</p>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Fechar modal de scanner" type="button">
            <X size={16} />
          </button>
        </div>

        <div className={styles.headerDivider} />

        <div className={styles.body}>
          <div className={styles.field}>
            <div className={styles.fieldMeta}>
              <span className={styles.stepBadge}>01</span>
              <span className={styles.fieldLabel}>
                Evento / Catálogo <span className={styles.required}>*</span>
              </span>
            </div>
            <p className={styles.fieldHint}>Escolha um evento existente ou crie um novo catálogo para este scan.</p>
            {newCatalogMode ? (
              <div className={styles.inputRow}>
                <input
                  className={styles.input}
                  placeholder="Nome do novo evento..."
                  value={newCatalogName}
                  onChange={(e) => setNewCatalogName(e.target.value)}
                  autoFocus
                />
                <button
                  className={styles.cancelNewBtn}
                  onClick={() => {
                    setNewCatalogMode(false);
                    setNewCatalogName('');
                  }}
                  title="Cancelar criação"
                  type="button"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className={styles.inputRow}>
                <select
                  className={styles.inputSelect}
                  value={catalogName}
                  onChange={(e) => setCatalogName(e.target.value)}
                >
                  {catalogs.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <button
                  className={styles.folderBtn}
                  onClick={() => setNewCatalogMode(true)}
                  title="Criar novo evento"
                  type="button"
                >
                  <Plus size={15} />
                </button>
              </div>
            )}
          </div>

          <div className={styles.field}>
            <div className={styles.fieldMeta}>
              <span className={styles.stepBadge}>02</span>
              <span className={styles.fieldLabel}>
                Pasta de Evento <span className={styles.required}>*</span>
              </span>
            </div>
            <p className={styles.fieldHint}>Fotos do evento que serão escaneadas e organizadas no catálogo.</p>
            <div className={styles.inputRow}>
              <input
                className={styles.input}
                placeholder="C:\\Fotos\\Formatura 2026..."
                value={oriPath}
                onChange={(e) => setOriPath(e.target.value)}
              />
              <button className={styles.folderBtn} onClick={pickOri} title="Selecionar pasta do evento" type="button">
                <FolderOpen size={14} />
              </button>
            </div>
          </div>

          <div className={styles.field}>
            <div className={styles.fieldMeta}>
              <span className={styles.stepBadge}>03</span>
              <span className={styles.fieldLabel}>Pasta de Referência</span>
            </div>
            <p className={styles.fieldHint}>Fotos nomeadas com o nome do formando. Usadas para treinar o reconhecimento facial.</p>
            <div className={styles.inputRow}>
              <input
                className={styles.input}
                placeholder="(opcional) C:\\Referencias\\Turma..."
                value={refPath}
                onChange={(e) => setRefPath(e.target.value)}
              />
              <button className={styles.folderBtn} onClick={pickRef} title="Selecionar pasta de referência" type="button">
                <FolderOpen size={14} />
              </button>
            </div>
          </div>

          <div className={styles.infoStrip}>
            <Info size={14} className={styles.infoIcon} />
            <span className={styles.infoText}>
              Evento: <strong>{activeCatalog || '—'}</strong>
              <span className={styles.infoSeparator}>·</span>
              O escaneamento continua em segundo plano após fechar este modal.
            </span>
          </div>

          {error && <p className={styles.errorMsg}>{error}</p>}

          <div className={styles.actions}>
            <button className={styles.cancelBtn} onClick={onClose} type="button">
              Cancelar
            </button>
            <button
              className={styles.scanBtn}
              onClick={handleScan}
              disabled={!canStart}
              type="button"
            >
              <Scan size={15} />
              <span>{starting ? 'Iniciando...' : 'Iniciar Scan'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
