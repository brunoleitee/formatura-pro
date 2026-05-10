import { useState, useEffect, useCallback } from 'react';
import { Save, RefreshCw, Trash2, Info } from 'lucide-react';
import { api, type QualitySettings, type AppSettings } from '../services/api';
import { useApp } from '../context/AppContext';

export default function SettingsView() {
  const { currentCatalog } = useApp();
  const [quality, setQuality] = useState<QualitySettings | null>(null);
  const [appCfg, setAppCfg] = useState<AppSettings | null>(null);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [q, a, s] = await Promise.all([
        api.getQualitySettings(),
        api.getSettings(),
        currentCatalog ? api.getStats(currentCatalog) : null,
      ]);
      setQuality(q);
      setAppCfg(a);
      if (s) setStats(s as Record<string, unknown>);
    } catch (e) { console.error(e); }
  }, [currentCatalog]);

  useEffect(() => { Promise.resolve().then(load); }, [load]);

  const saveQuality = async () => {
    if (!quality) return;
    setSaving(true);
    setMsg('');
    try {
      const updated = await api.updateQualitySettings(quality);
      setQuality(updated);
      setMsg('Configurações de qualidade salvas.');
    } catch { setMsg('Erro ao salvar.'); }
    setSaving(false);
  };

  const handleClearCache = async () => {
    setClearing(true);
    try {
      await api.clearCache();
      setMsg('Cache limpo com sucesso.');
    } catch { setMsg('Erro ao limpar cache.'); }
    setClearing(false);
  };

  const qField = (
    label: string,
    key: keyof QualitySettings,
    min: number,
    max: number,
    step = 1,
    hint?: string
  ) => (
    <div className="config-section">
      <label className="config-label">
        {label}
        {hint && <span className="config-hint">{hint}</span>}
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={quality?.[key] ?? min}
          onChange={e => setQuality(prev => prev ? { ...prev, [key]: parseFloat(e.target.value) } : prev)}
          style={{ flex: 1 }}
        />
        <span className="config-value">{quality?.[key] ?? '—'}</span>
      </div>
    </div>
  );

  return (
    <div className="view-container">
      <div className="view-header">
        <h1>Configurações</h1>
      </div>

      {msg && <div className="review-msg" style={{ marginBottom: 16 }}>{msg}</div>}

      <div className="settings-layout">
        {/* Quality Settings */}
        <div className="settings-card">
          <h3>Qualidade de Imagem</h3>
          {quality ? (
            <>
              {qField('Limite "desfocada"', 'blur_blurry_threshold', 10, 200, 5,
                'Pontuação abaixo deste valor = foto desfocada')}
              {qField('Limite "atenção"', 'blur_attention_threshold', 50, 300, 5,
                'Pontuação abaixo deste valor = atenção (acima = ok)')}
              {qField('Mínimo de fotos por pessoa', 'min_photos_per_person', 1, 20, 1,
                'Pessoas com menos fotos aparecem como pendentes')}
              {qField('Score mínimo busca manual', 'manual_search_min_score', 0.1, 0.95, 0.05,
                'Similaridade mínima para busca manual de faces')}
              <button
                className="btn-primary"
                style={{ marginTop: 16 }}
                onClick={saveQuality}
                disabled={saving}
              >
                <Save size={16} />
                {saving ? 'Salvando...' : 'Salvar Qualidade'}
              </button>
            </>
          ) : (
            <div className="empty-state" style={{ padding: 24 }}>
              <RefreshCw size={20} className="spin" />
            </div>
          )}
        </div>

        {/* Stats */}
        {stats && (
          <div className="settings-card">
            <h3>Estatísticas do Evento</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <span className="stat-value">{String(stats.total_photos ?? 0)}</span>
                <span className="stat-label">Fotos</span>
              </div>
              <div className="stat-item">
                <span className="stat-value">{String(stats.total_people ?? 0)}</span>
                <span className="stat-label">Pessoas</span>
              </div>
              <div className="stat-item">
                <span className="stat-value">{String(stats.total_occurrences ?? 0)}</span>
                <span className="stat-label">Ocorrências</span>
              </div>
              <div className="stat-item">
                <span className="stat-value" style={{ color: 'var(--warning-color)' }}>{String(stats.unknown_count ?? 0)}</span>
                <span className="stat-label">Não Identificadas</span>
              </div>
            </div>
          </div>
        )}

        {/* App Settings */}
        {appCfg && (
          <div className="settings-card">
            <h3>Configurações do App</h3>
            <div className="config-section">
              <label className="config-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(appCfg.auto_backup)}
                  onChange={async e => {
                    const updated = { ...appCfg, auto_backup: e.target.checked };
                    setAppCfg(updated as AppSettings);
                    await api.updateSettings(updated).catch(console.error);
                  }}
                />
                Backup automático ativado
              </label>
            </div>
          </div>
        )}

        {/* Cache */}
        <div className="settings-card">
          <h3>Manutenção</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              <Info size={14} />
              <span>Limpar o cache de qualidade força reanálise das fotos.</span>
            </div>
            <button
              className="btn-danger"
              onClick={handleClearCache}
              disabled={clearing}
            >
              <Trash2 size={16} />
              {clearing ? 'Limpando...' : 'Limpar Cache de Qualidade'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
