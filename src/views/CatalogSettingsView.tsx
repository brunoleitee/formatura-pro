import { useState, useEffect } from 'react';
import { catalogApi } from '../services/api';
import { useApp } from '../context/AppContext';
import type { CatalogSettingsResponse } from '../services/api';

export default function CatalogSettingsView() {
  const { currentCatalog } = useApp();
  const [settings, setSettings] = useState<CatalogSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentCatalog) return;
    setLoading(true);
    catalogApi.getCatalogSettings(currentCatalog)
      .then(setSettings)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [currentCatalog]);

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      padding: 24, gap: 20, color: '#e2e8f0',
      fontFamily: 'inherit', fontSize: 13,
    }}>
      <div style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9' }}>
        Configurações do Catálogo
      </div>
      <div style={{ color: '#6b7a8e', fontSize: 12 }}>
        {currentCatalog ? `Catálogo: ${currentCatalog}` : 'Nenhum catálogo selecionado'}
      </div>

      {loading ? (
        <div style={{ color: '#6b7a8e', padding: 20 }}>Carregando...</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
          <div style={{ padding: 16, borderRadius: 8, background: '#0e0f14', border: '1px solid #1a1c23' }}>
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Pastas vinculadas</div>
            {settings?.scan_paths && settings.scan_paths.length > 0 ? (
              <ul style={{ margin: 0, padding: '0 0 0 16px', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {settings.scan_paths.map((p, i) => (
                  <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#94a3b8' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', display: 'inline-block' }} />
                    {p}
                  </li>
                ))}
              </ul>
            ) : (
              <div style={{ color: '#6b7a8e', fontSize: 12, fontStyle: 'italic' }}>
                Nenhuma pasta vinculada
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button disabled style={{
              padding: '8px 16px', borderRadius: 6, border: '1px solid #1a1c23',
              background: '#0e0f14', color: '#6b7a8e', cursor: 'not-allowed', fontSize: 12,
            }}>
              + Adicionar pasta
            </button>
            <button disabled style={{
              padding: '8px 16px', borderRadius: 6, border: '1px solid #1a1c23',
              background: '#0e0f14', color: '#6b7a8e', cursor: 'not-allowed', fontSize: 12,
            }}>
              Sincronizar catálogo
            </button>
            <button disabled style={{
              padding: '8px 16px', borderRadius: 6, border: '1px solid #1a1c23',
              background: '#0e0f14', color: '#6b7a8e', cursor: 'not-allowed', fontSize: 12,
            }}>
              Gerenciar eventos
            </button>
          </div>

          <div style={{ color: '#3d4352', fontSize: 11, fontStyle: 'italic', marginTop: 8 }}>
            Estas funcionalidades estarão disponíveis em breve.
          </div>
        </div>
      )}
    </div>
  );
}
