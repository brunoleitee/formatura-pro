import { useState, useEffect, useCallback, useRef } from 'react';
import { Save, RefreshCw, Trash2, Info, Image, Settings2, Cpu, FolderOpen, Palette } from 'lucide-react';
import { api, type QualitySettings, type AppSettings } from '../services/api';
import { useApp } from '../context/AppContext';

const ACCENT_OPTIONS = [
  { id: 'blue',   label: 'Azul',    color: '#3b82f6' },
  { id: 'green',  label: 'Verde',   color: '#10b981' },
  { id: 'purple', label: 'Roxo',    color: '#8b5cf6' },
  { id: 'orange', label: 'Laranja', color: '#f97316' },
  { id: 'pink',   label: 'Rosa',    color: '#ec4899' },
  { id: 'gray',   label: 'Cinza',   color: '#6b7280' },
];

function isCustomColor(id: string) {
  return id.startsWith('custom_');
}

function getDisplayColor(id: string) {
  if (isCustomColor(id)) return id.replace('custom_', '');
  return ACCENT_OPTIONS.find(o => o.id === id)?.color || '#3b82f6';
}

type SettingsTab = 'quality' | 'export' | 'performance' | 'system' | 'appearance';

export default function SettingsView() {
  const { currentCatalog, accentColor, setAccentColor } = useApp();
  const [tab, setTab] = useState<SettingsTab>('quality');
  const [quality, setQuality] = useState<QualitySettings | null>(null);
  const [appCfg, setAppCfg] = useState<AppSettings | null>(null);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [clearing, setClearing] = useState(false);

  const loadAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    // Cancelar request anterior se existir
    if (loadAbortRef.current) {
      loadAbortRef.current.abort();
    }
    const controller = new AbortController();
    loadAbortRef.current = controller;

    try {
      const [q, a, s] = await Promise.all([
        api.getQualitySettings(controller.signal),
        api.getSettings(controller.signal),
        currentCatalog ? api.getStats(currentCatalog, controller.signal) : null,
      ]);
      if (controller.signal.aborted) return;
      setQuality(q);
      setAppCfg(a);
      if (s) setStats(s as Record<string, unknown>);
    } catch (e) {
      if (e instanceof Error && e.name !== 'AbortError') {
        console.error(e);
      }
    }
  }, [currentCatalog]);

  useEffect(() => {
    Promise.resolve().then(load);
    return () => {
      if (loadAbortRef.current) {
        loadAbortRef.current.abort();
      }
    };
  }, [load]);

  const saveQuality = async () => {
    if (!quality) return;
    setSaving(true); setMsg('');
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
          className="slider-base"
          style={{ flex: 1 }}
        />
        <span className="config-value">{quality?.[key] ?? '—'}</span>
      </div>
    </div>
  );

  const TABS: { key: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { key: 'quality', label: 'Qualidade', icon: <Image size={15} /> },
    { key: 'export', label: 'Exportação', icon: <FolderOpen size={15} /> },
    { key: 'performance', label: 'Performance', icon: <Cpu size={15} /> },
    { key: 'system', label: 'Sistema', icon: <Settings2 size={15} /> },
    { key: 'appearance', label: 'Aparência', icon: <Palette size={15} /> },
  ];

  return (
    <div className="view-container">
      <div className="view-header">
        <h1>Configurações</h1>
      </div>

      {msg && <div className="review-msg" style={{ marginBottom: 16 }}>{msg}</div>}

      <div className="settings-tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`tab-btn ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <div className="settings-layout">
        {tab === 'quality' && (
          <>
            <div className="settings-card">
              <h3>Qualidade de Imagem <span className="badge badge-blue badge-sm">IA</span></h3>
              <p className="config-hint" style={{ marginTop: -8, maxWidth: 480 }}>
                Ajusta os limites usados pelo sistema de qualidade para classificar fotos como nítidas, em atenção ou desfocadas.
              </p>
              {quality ? (
                <>
                  {qField('Limite "desfocada"', 'blur_blurry_threshold', 10, 200, 5,
                    'Pontuação abaixo deste valor = foto desfocada')}
                  {qField('Limite "atenção"', 'blur_attention_threshold', 50, 300, 5,
                    'Pontuação abaixo deste valor = atenção (acima = ok)')}
                  <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
                    <button className="btn-primary" onClick={saveQuality} disabled={saving}>
                      <Save size={16} />
                      {saving ? 'Salvando...' : 'Salvar Qualidade'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="empty-state" style={{ padding: 24 }}>
                  <RefreshCw size={20} className="spin" />
                </div>
              )}
            </div>

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
                    <span className="stat-value" style={{ color: 'var(--warning)' }}>{String(stats.unknown_count ?? 0)}</span>
                    <span className="stat-label">Não Identificadas</span>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'export' && (
          <div className="settings-card">
            <h3>Exportação <span className="badge badge-amber badge-sm">Breve</span></h3>
            <p className="config-hint" style={{ marginTop: -8 }}>
              Preferências de exportação serão configuradas aqui em breve.
            </p>
          </div>
        )}

        {tab === 'performance' && (
          <div className="settings-card">
            <h3>Performance</h3>
            <p className="config-hint" style={{ marginTop: -8 }}>
              Configurações de desempenho e uso de recursos.
            </p>
            {appCfg && (
              <div className="config-section">
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(appCfg.auto_backup)}
onChange={async e => {
  const prev = appCfg;
  const updated = { ...appCfg, auto_backup: e.target.checked };
  setAppCfg(updated as AppSettings);
  try {
    await api.updateSettings(updated);
  } catch {
    setAppCfg(prev);
    setMsg('Erro ao salvar configuração');
  }
}}
                  />
                  Backup automático ativado
                </label>
              </div>
            )}
          </div>
        )}

        {tab === 'system' && (
          <div className="settings-card">
            <h3>Sistema</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                <Info size={14} />
                <span>Limpar o cache de qualidade força reanálise das fotos.</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
                <button className="btn-danger" onClick={handleClearCache} disabled={clearing}>
                  <Trash2 size={16} />
                  {clearing ? 'Limpando...' : 'Limpar Cache de Qualidade'}
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'appearance' && (
          <div className="settings-card">
            <h3>Cor de destaque</h3>
            <p className="config-hint" style={{ marginTop: -8, maxWidth: 480 }}>
              Personalize a cor principal da interface (botões, seleções, links).
            </p>
            <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              {ACCENT_OPTIONS.map(opt => (
                <button
                  key={opt.id}
                  onClick={() => setAccentColor(opt.id)}
                  style={{
                    width: 44, height: 44, borderRadius: '50%', border: '3px solid',
                    borderColor: accentColor === opt.id ? opt.color : 'transparent',
                    background: opt.color, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'border-color 0.15s, transform 0.15s',
                    transform: accentColor === opt.id ? 'scale(1.1)' : 'scale(1)',
                    outline: 'none',
                  }}
                  title={opt.label}
                  aria-label={opt.label}
                >
                  {accentColor === opt.id && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              ))}
              <label
                style={{
                  width: 44, height: 44, borderRadius: '50%',
                  border: isCustomColor(accentColor) ? '3px solid var(--accent)' : '2px dashed var(--border-strong)',
                  background: isCustomColor(accentColor) ? getDisplayColor(accentColor) : 'var(--bg-secondary)',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'border-color 0.15s, transform 0.15s',
                  transform: isCustomColor(accentColor) ? 'scale(1.1)' : 'scale(1)',
                  overflow: 'hidden', position: 'relative',
                }}
                title="Cor personalizada"
                aria-label="Escolher cor personalizada"
              >
                <span style={{ fontSize: '0.65rem', color: isCustomColor(accentColor) ? 'white' : 'var(--text-secondary)', fontWeight: 700, lineHeight: 1, textAlign: 'center' }}>
                  {isCustomColor(accentColor) ? '✓' : '+'}
                </span>
                <input
                  type="color"
                  value={isCustomColor(accentColor) ? getDisplayColor(accentColor) : '#3b82f6'}
                  onChange={e => setAccentColor(`custom_${e.target.value}`)}
                  style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
                />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 8, marginLeft: 4, alignItems: 'center' }}>
              {ACCENT_OPTIONS.map(opt => (
                <span key={opt.id} style={{ width: 44, textAlign: 'center', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                  {opt.label}
                </span>
              ))}
              <span style={{ width: 44, textAlign: 'center', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                Custom
              </span>
            </div>

            <div style={{ marginTop: 24, padding: 16, borderRadius: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 12 }}>Prévia</p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn-primary" style={{ pointerEvents: 'none' }}>Botão</button>
                <span style={{ color: 'var(--accent)', fontWeight: 600, fontSize: '0.85rem' }}>Link de exemplo</span>
                <span className="badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 6, padding: '2px 8px', fontSize: '0.75rem', fontWeight: 600 }}>Badge</span>
                <div style={{ width: 20, height: 20, borderRadius: 6, background: 'var(--accent)', opacity: 0.3 }} />
                <div style={{ width: 20, height: 20, borderRadius: 6, background: 'var(--accent)', opacity: 0.5 }} />
                <div style={{ width: 20, height: 20, borderRadius: 6, background: 'var(--accent)' }} />
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
