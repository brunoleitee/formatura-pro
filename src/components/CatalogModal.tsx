import { useState, useEffect } from 'react';
import { Plus, Folder, Trash2, Edit2, Check, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../services/api';

interface Props {
  onClose: () => void;
  onRequestConfirm: (options: { title: string; message: string; confirmText: string; cancelText: string }) => Promise<boolean>;
}

export default function CatalogModal({ onClose, onRequestConfirm }: Props) {
  const { catalogs, currentCatalog, setCatalog, refreshCatalogs } = useApp();
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { refreshCatalogs(); }, [refreshCatalogs]);

  const handleSelect = async (name: string) => {
    await setCatalog(name);
    onClose();
  };

  function autoCatalogName(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `Catalogo_${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  }

  const handleCreate = async () => {
    const trimmed = newName.trim() || autoCatalogName();
    setCreating(true);
    setError('');
    try {
      await api.setCatalog(trimmed);
      await refreshCatalogs();
      await setCatalog(trimmed);
      onClose();
    } catch {
      setError('Não foi possível criar o evento. Verifique o nome.');
    } finally {
      setCreating(false);
      setNewName('');
    }
  };

  const handleRenameConfirm = async (oldName: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === oldName) { setRenamingId(null); return; }
    try {
      await api.renameCatalog(oldName, trimmed);
      await refreshCatalogs();
      if (currentCatalog === oldName) await setCatalog(trimmed);
    } catch {
      setError('Erro ao renomear.');
    }
    setRenamingId(null);
  };

  const handleDelete = async (name: string) => {
    const confirmed = await onRequestConfirm({
      title: 'Excluir evento?',
      message: `Excluir o evento "${name}"? Esta ação não pode ser desfeita.`,
      confirmText: 'Excluir',
      cancelText: 'Cancelar',
    });
    if (!confirmed) return;
    try {
      await api.deleteCatalog(name);
      await refreshCatalogs();
    } catch {
      setError('Erro ao excluir.');
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <div className="modal-header">
          <h2>Selecionar Evento / Catálogo</h2>
          {currentCatalog && (
            <button className="icon-btn" onClick={onClose}><X size={18} /></button>
          )}
        </div>

        {catalogs.length === 0 && (
          <p className="modal-empty">Nenhum evento encontrado. Crie um novo para começar.</p>
        )}

        <div className="catalog-list">
          {catalogs.map(cat => (
            <div
              key={cat}
              className={`catalog-item ${cat === currentCatalog ? 'active' : ''}`}
            >
              {renamingId === cat ? (
                <div className="catalog-rename">
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleRenameConfirm(cat);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                  />
                  <button className="icon-btn success" onClick={() => handleRenameConfirm(cat)}><Check size={16} /></button>
                  <button className="icon-btn" onClick={() => setRenamingId(null)}><X size={16} /></button>
                </div>
              ) : (
                <>
                  <button className="catalog-select" onClick={() => handleSelect(cat)}>
                    <Folder size={18} />
                    <span>{cat}</span>
                    {cat === currentCatalog && <span className="badge-active">Ativo</span>}
                  </button>
                  <div className="catalog-actions">
                    <button className="icon-btn" title="Renomear" onClick={() => {
                      setRenamingId(cat);
                      setRenameValue(cat);
                    }}><Edit2 size={14} /></button>
                    <button className="icon-btn danger" title="Excluir" onClick={() => handleDelete(cat)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="modal-create">
          <input
            placeholder="Nome do novo evento..."
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
          />
          <button
            className="btn-primary"
            onClick={handleCreate}
            disabled={creating}
          >
            <Plus size={16} />
            {creating ? 'Criando...' : 'Criar'}
          </button>
        </div>

        {error && <p className="modal-error">{error}</p>}
      </div>
    </div>
  );
}
