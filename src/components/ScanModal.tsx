import { useState } from 'react';
import { FolderOpen, Scan, X, Info, Plus } from 'lucide-react';
import { api } from '../services/api';
import { useApp } from '../context/AppContext';

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
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: 500 }}>
        <div className="modal-header">
          <h2>Escanear Fotos</h2>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Catalog selector */}
          <div className="config-section">
            <label className="config-label">
              Evento / Catálogo *
              <span className="config-hint">Selecione um existente ou crie um novo.</span>
            </label>
            {newCatalogMode ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="config-input"
                  placeholder="Nome do novo evento..."
                  value={newCatalogName}
                  onChange={e => setNewCatalogName(e.target.value)}
                  autoFocus
                />
                <button
                  className="btn-secondary"
                  onClick={() => { setNewCatalogMode(false); setNewCatalogName(''); }}
                  title="Cancelar"
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  className="config-input"
                  value={catalogName}
                  onChange={e => setCatalogName(e.target.value)}
                  style={{ flex: 1 }}
                >
                  {catalogs.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <button
                  className="btn-secondary"
                  onClick={() => setNewCatalogMode(true)}
                  title="Criar novo evento"
                >
                  <Plus size={16} />
                </button>
              </div>
            )}
          </div>

          {/* Reference folder */}
          <div className="config-section">
            <label className="config-label">
              Pasta de Referência
              <span className="config-hint">
                Fotos nomeadas com o nome do formando (ex: "João Silva.jpg").
                Usada para treinar o reconhecimento facial.
              </span>
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="config-input"
                placeholder="(opcional) C:\Referencias\Turma..."
                value={refPath}
                onChange={e => setRefPath(e.target.value)}
              />
              <button className="btn-secondary" onClick={pickRef} title="Selecionar pasta">
                <FolderOpen size={16} />
              </button>
            </div>
          </div>

          {/* Event folder */}
          <div className="config-section">
            <label className="config-label">
              Pasta de Evento *
              <span className="config-hint">
                Fotos tiradas no evento da formatura para identificar.
              </span>
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="config-input"
                placeholder="C:\Fotos\Formatura 2026..."
                value={oriPath}
                onChange={e => setOriPath(e.target.value)}
              />
              <button className="btn-secondary" onClick={pickOri} title="Selecionar pasta">
                <FolderOpen size={16} />
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
            <Info size={14} style={{ flexShrink: 0 }} />
            <span>
              Evento: <strong style={{ color: 'var(--accent-color)' }}>{activeCatalog || '—'}</strong>
              &nbsp;· O escaneamento continua em segundo plano após fechar este modal.
            </span>
          </div>

          {error && <p className="modal-error" style={{ margin: 0 }}>{error}</p>}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn-secondary" onClick={onClose}>Cancelar</button>
            <button
              className="btn-primary"
              onClick={handleScan}
              disabled={starting || !oriPath || !activeCatalog}
            >
              <Scan size={16} />
              {starting ? 'Iniciando...' : 'Iniciar Scan'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
