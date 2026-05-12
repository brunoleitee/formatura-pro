import { useState } from 'react';
import { FolderOpen, Scan, X, Info, Plus } from 'lucide-react';
import { api } from '../services/api';
import { useApp } from '../context/AppContext';
import styles from './ScanModal.module.css';

interface Props {
  onClose: () => void;
  onScanStarted: () => void;
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

  const handleScan = async () => {
    if (!oriPath) { setError('Selecione a pasta de evento.'); return; }
    if (!activeCatalog) { setError('Informe o nome do evento/catálogo.'); return; }
    setError('');
    setStarting(true);
    try {
      await api.scanFolder(oriPath, refPath, activeCatalog);
      await setCatalog(activeCatalog);
      await refreshCatalogs();
      onScanStarted();
      onClose();
    } catch (e) {
      setError('Erro ao iniciar o escaneamento. Verifique o backend.');
      setStarting(false);
    }
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>

        {/* Gradient top strip */}
        <div className={styles.topStrip} />

        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.iconBadge}>
              <Scan size={17} />
            </div>
            <div className={styles.titleGroup}>
              <h2 className={styles.title}>Escanear Fotos</h2>
              <p className={styles.subtitle}>Configure as pastas e inicie o processamento</p>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className={styles.headerDivider} />

        {/* Body */}
        <div className={styles.body}>

          {/* Step 01 — Catalog */}
          <div className={styles.field}>
            <div className={styles.fieldMeta}>
              <span className={styles.stepBadge}>01</span>
              <span className={styles.fieldLabel}>
                Evento / Catálogo <span className={styles.required}>*</span>
              </span>
            </div>
            <p className={styles.fieldHint}>Selecione um existente ou crie um novo.</p>
            {newCatalogMode ? (
              <div className={styles.inputRow}>
                <input
                  className={styles.input}
                  placeholder="Nome do novo evento..."
                  value={newCatalogName}
                  onChange={e => setNewCatalogName(e.target.value)}
                  autoFocus
                />
                <button
                  className={styles.cancelNewBtn}
                  onClick={() => { setNewCatalogMode(false); setNewCatalogName(''); }}
                  title="Cancelar"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className={styles.inputRow}>
                <select
                  className={styles.inputSelect}
                  value={catalogName}
                  onChange={e => setCatalogName(e.target.value)}
                >
                  {catalogs.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <button
                  className={styles.folderBtn}
                  onClick={() => setNewCatalogMode(true)}
                  title="Criar novo evento"
                >
                  <Plus size={14} />
                </button>
              </div>
            )}
          </div>

          {/* Step 02 — Event folder */}
          <div className={styles.field}>
            <div className={styles.fieldMeta}>
              <span className={styles.stepBadge}>02</span>
              <span className={styles.fieldLabel}>
                Pasta de Evento <span className={styles.required}>*</span>
              </span>
            </div>
            <p className={styles.fieldHint}>
              Fotos tiradas no evento da formatura para identificar.
            </p>
            <div className={styles.inputRow}>
              <input
                className={styles.input}
                placeholder="C:\Fotos\Formatura 2026..."
                value={oriPath}
                onChange={e => setOriPath(e.target.value)}
              />
              <button className={styles.folderBtn} onClick={pickOri} title="Selecionar pasta">
                <FolderOpen size={14} />
              </button>
            </div>
          </div>

          {/* Step 03 — Reference folder */}
          <div className={styles.field}>
            <div className={styles.fieldMeta}>
              <span className={styles.stepBadge}>03</span>
              <span className={styles.fieldLabel}>Pasta de Referência</span>
            </div>
            <p className={styles.fieldHint}>
              Fotos nomeadas com o nome do formando (ex: "João Silva.jpg"). Usada para treinar o reconhecimento facial.
            </p>
            <div className={styles.inputRow}>
              <input
                className={styles.input}
                placeholder="(opcional) C:\Referencias\Turma..."
                value={refPath}
                onChange={e => setRefPath(e.target.value)}
              />
              <button className={styles.folderBtn} onClick={pickRef} title="Selecionar pasta">
                <FolderOpen size={14} />
              </button>
            </div>
          </div>

          <div className={styles.divider} />

          {/* Info */}
          <div className={styles.infoStrip}>
            <Info size={13} className={styles.infoIcon} />
            <span className={styles.infoText}>
              Evento: <strong>{activeCatalog || '—'}</strong>
              &nbsp;· O escaneamento continua em segundo plano após fechar este modal.
            </span>
          </div>

          {error && <p className={styles.errorMsg}>{error}</p>}

          {/* Actions */}
          <div className={styles.actions}>
            <button className={styles.cancelBtn} onClick={onClose}>
              Cancelar
            </button>
            <button
              className={styles.scanBtn}
              onClick={handleScan}
              disabled={starting || !oriPath || !activeCatalog}
            >
              <Scan size={14} />
              {starting ? 'Iniciando...' : 'Iniciar Scan'}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
