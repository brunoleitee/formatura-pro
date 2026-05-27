import { useState, useEffect, useCallback } from 'react';
import { Sparkles, RefreshCw, ChevronUp, ChevronDown, Cpu, Download, AlertTriangle, CheckCircle, Info, ExternalLink, Zap } from 'lucide-react';
import { api, type GraduationAnalysisStatus } from '../../services/api';
import styles from '../../views/ReviewView.module.css';

interface Props {
  status: GraduationAnalysisStatus | null;
  isStarting: boolean;
  onStart: (useAiUltra: boolean) => void;
}

interface OllamaStatus {
  running: boolean;
  has_model: boolean;
  version?: string;
  models: string[];
}

interface DownloadStatus {
  status: string;
  message: string;
  percent: number;
}

function isOllamaVersionOutdated(versionStr?: string): boolean {
  if (!versionStr) return false;
  // Extrai apenas números e pontos (ex: "0.24.0" ou "ollama version is 0.1.24")
  const cleanVersion = versionStr.replace(/[^\d.]/g, '');
  const parts = cleanVersion.split('.').map(Number);
  if (parts.length >= 2) {
    const major = parts[0];
    const minor = parts[1];
    const patch = parts[2] || 0;
    
    // Se for versão 0.x, precisa ser no mínimo 0.5.7
    if (major === 0) {
      if (minor < 5) return true;
      if (minor === 5 && patch < 7) return true;
    }
  }
  return false;
}

export default function GraduationAnalysisPanel({ status, isStarting, onStart }: Props) {
  const [open, setOpen] = useState(false);
  const [useAiUltra, setUseAiUltra] = useState(false);
  
  // Estados para o Ollama local
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [isCheckingOllama, setIsCheckingOllama] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  // Estados para download automático do instalador do Ollama
  const [isDownloadingInstaller, setIsDownloadingInstaller] = useState(false);
  const [installerProgress, setInstallerProgress] = useState<DownloadStatus | null>(null);

  const isRunning = Boolean(status?.is_running);
  const progress = Math.max(0, Math.min(100, (status?.progress ?? 0) * 100));
  const hasResult = Boolean(status?.result);

  // Verifica o status do Ollama local
  const checkOllama = useCallback(async () => {
    setIsCheckingOllama(true);
    try {
      const res = await api.getOllamaStatus();
      setOllamaStatus(res);
      // Se possui o modelo qwen2.5-vl e o Ollama está rodando, ativamos a IA local por comodidade
      if (res.running && res.has_model) {
        setUseAiUltra(true);
      }
    } catch (e) {
      console.error('[Ollama] erro ao checar status:', e);
      setOllamaStatus({ running: false, has_model: false, models: [] });
    } finally {
      setIsCheckingOllama(false);
    }
  }, []);

  // Roda uma verificação na primeira renderização
  useEffect(() => {
    checkOllama();
  }, [checkOllama]);

  // Se o painel for aberto, roda um check sutil do status se ainda não tiver verificado
  useEffect(() => {
    if (open && !ollamaStatus) {
      checkOllama();
    }
  }, [open, ollamaStatus, checkOllama]);

  // Executa o download da IA local com streaming em tempo real
  const handleDownloadModel = async () => {
    if (isDownloading) return;
    setIsDownloading(true);
    setDownloadStatus({ status: 'starting', message: 'Iniciando conexão...', percent: 0 });
    
    try {
      const url = api.pullOllamaModelUrl();
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!response.body) {
        throw new Error('Streaming não suportado pelo navegador.');
      }
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.trim()) {
            try {
              const data = JSON.parse(line) as { status: string; message?: string; percent?: number };
              setDownloadStatus({
                status: data.status,
                message: data.message || 'Fazendo download...',
                percent: typeof data.percent === 'number' ? data.percent : 0
              });
              
              if (data.status === 'success') {
                // Modelo baixado com sucesso!
                // Aguarda um instante para o Ollama registrar manifests e blobs do modelo
                await new Promise(resolve => setTimeout(resolve, 3000));
                const finalRes = await api.getOllamaStatus();
                setOllamaStatus(finalRes);
                setUseAiUltra(true);
              }
            } catch (err) {
              // Ignore line parse errors for partial chunks
            }
          }
        }
      }
    } catch (err: any) {
      console.error('[Ollama] erro ao baixar modelo:', err);
      setDownloadStatus({
        status: 'error',
        message: err.message || 'Erro ao conectar ou baixar o modelo.',
        percent: 0
      });
    } finally {
      setIsDownloading(false);
    }
  };

  // Executa o download automático do executável do instalador do Ollama
  const handleDownloadInstaller = async () => {
    if (isDownloadingInstaller) return;
    setIsDownloadingInstaller(true);
    setInstallerProgress({ status: 'starting', message: 'Conectando ao servidor...', percent: 0 });
    
    try {
      const url = api.downloadOllamaInstallerUrl();
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!response.body) {
        throw new Error('Streaming não suportado pelo navegador.');
      }
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.trim()) {
            try {
              const data = JSON.parse(line) as { status: string; message?: string; percent?: number };
              setInstallerProgress({
                status: data.status,
                message: data.message || 'Fazendo download do instalador...',
                percent: typeof data.percent === 'number' ? data.percent : 0
              });
              
              if (data.status === 'success') {
                // Instalador baixado com sucesso!
                // Aguarda 2 segundos para o processo nativo iniciar perfeitamente
                await new Promise(resolve => setTimeout(resolve, 2000));
                const finalRes = await api.getOllamaStatus();
                setOllamaStatus(finalRes);
              }
            } catch (err) {
              // Ignore partial chunk parse errors
            }
          }
        }
      }
    } catch (err: any) {
      console.error('[Ollama] erro ao baixar instalador:', err);
      setInstallerProgress({
        status: 'error',
        message: err.message || 'Falha ao baixar o instalador.',
        percent: 0
      });
    } finally {
      setIsDownloadingInstaller(false);
    }
  };

  // Label amigável para o botão principal de análise
  let buttonLabel = isRunning || isStarting ? 'Analisando...' : (hasResult ? 'Reanalisar' : 'Analisar');
  if (isDownloading) {
    buttonLabel = 'Baixando IA...';
  } else if (isDownloadingInstaller) {
    buttonLabel = 'Baixando Ollama...';
  }

  // Texto compacto de status principal na barra fechada
  let compactStatus: string;
  if (isStarting && !isRunning) {
    compactStatus = 'Gerando embeddings das fotos...';
  } else if (isRunning) {
    const sourceLabel = status?.result?.source === 'qwen2.5-vl' || useAiUltra ? 'IA local' : 'HSV';
    compactStatus = `Analisando com ${sourceLabel}: ${status?.processed ?? 0}/${status?.total ?? 0} (${Math.round(progress)}%)`;
  } else if (status?.error) {
    compactStatus = status.error;
  } else if (status?.result) {
    const n = status.result.processed_files;
    const isAi = status.result.source === 'qwen2.5-vl';
    compactStatus = `Análise concluída (${isAi ? 'IA local' : 'Heurísticas HSV'}): ${n} foto${n !== 1 ? 's' : ''}`;
  } else {
    compactStatus = 'Itens de formatura não analisados';
  }

  // O botão de analisar deve ser desativado se o Modo Ultra estiver selecionado,
  // mas o Ollama não estiver configurado corretamente (sem estar rodando ou sem o modelo).
  const isAiDisabled = useAiUltra && (!ollamaStatus?.running || !ollamaStatus?.has_model);
  const isStartDisabled = isRunning || isStarting || isDownloading || isDownloadingInstaller || isAiDisabled;

  return (
    <div className={`${styles.analysisPanel} ${open ? styles.analysisPanelOpen : ''}`}>
      {/* Visualização Compacta Superior */}
      <div className={styles.analysisCompact}>
        <span className={styles.analysisEyebrow}>
          <Sparkles size={11} />
          <span>{compactStatus}</span>
          {!isRunning && !isStarting && useAiUltra && ollamaStatus?.running && ollamaStatus?.has_model && (
            <span className={styles.badgeReady}>
              <span className={styles.pulseGreen} />
              IA Ultra ativa
            </span>
          )}
        </span>
        
        {(isRunning || isStarting) && (
          <span className={styles.analysisCompactBar}>
            <span
              className={`${styles.analysisCompactBarFill} ${isStarting && !isRunning ? styles.analysisCompactBarIndeterminate : ''}`}
              style={isRunning ? { width: `${progress}%` } : undefined}
            />
          </span>
        )}
        
        <button
          type="button"
          className={styles.analysisButton}
          onClick={() => onStart(useAiUltra)}
          disabled={isStartDisabled}
        >
          <RefreshCw
            size={11}
            className={`${styles.spin} ${isRunning || isStarting || isDownloading ? styles.inlineVisible : styles.inlineHidden}`}
          />
          <span>{buttonLabel}</span>
        </button>
        
        <button
          type="button"
          className={styles.analysisToggle}
          onClick={() => setOpen(v => !v)}
          title={open ? 'Recolher' : 'Detalhes'}
        >
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>

      {/* Visualização Expandida Detalhada */}
      {open && (
        <div className={styles.analysisDetails}>
          <p className={styles.analysisStatus}>
            <span>Selecione a tecnologia de triagem para identificar automaticamente os itens de formatura (beca, canudo, capelo, faixa e jabor) nas fotos:</span>
          </p>

          {/* Seletor de Tecnologia / Modos */}
          <div className={styles.modeSelector}>
            {/* Modo Clássico (HSV) */}
            <div
              className={`${styles.modeCard} ${!useAiUltra ? styles.modeCardActive : ''}`}
              onClick={() => {
                if (!isRunning && !isStarting && !isDownloading) {
                  setUseAiUltra(false);
                }
              }}
            >
              <span className={styles.modeCardTitle}>
                <Zap size={13} />
                Modo Padrão (Filtro HSV)
              </span>
              <span className={styles.modeCardDesc}>
                Triagem rápida baseada em heurísticas e faixas de cores. Leve, porém suscetível a falsos positivos e variações de iluminação.
              </span>
            </div>

            {/* Modo Ultra (IA Local) */}
            <div
              className={`${styles.modeCard} ${useAiUltra ? styles.modeCardActive : ''}`}
              onClick={() => {
                if (!isRunning && !isStarting && !isDownloading) {
                  setUseAiUltra(true);
                  if (!ollamaStatus) {
                    checkOllama();
                  }
                }
              }}
            >
              <span className={styles.modeCardTitle}>
                <Cpu size={13} />
                Modo Ultra (IA local)
              </span>
              <span className={styles.modeCardDesc}>
                Usa o modelo de visão Qwen2.5-VL local de alta fidelidade para entender semântica. Identificação precisa de beca, jabor, faixa, etc.
              </span>
            </div>
          </div>

          {/* Painel Dinâmico do Ollama se Modo Ultra estiver Ativo */}
          {useAiUltra && (
            <div className="mt-2">
              {/* Caso 1: Verificando status do Ollama */}
              {isCheckingOllama && !ollamaStatus && (
                <div className={`${styles.ollamaStatusBox} ${styles.ollamaStatusBoxWarning}`}>
                  <div className={styles.ollamaTitle}>
                    <RefreshCw size={14} className={styles.spin} />
                    Verificando status do ambiente local...
                  </div>
                  <p className={styles.ollamaText}>
                    Verificando se o Ollama está rodando no computador. Por favor, aguarde...
                  </p>
                </div>
              )}

              {/* Caso 2: Ollama não rodando ou indisponível */}
              {ollamaStatus && !ollamaStatus.running && (
                <div className={`${styles.ollamaStatusBox} ${styles.ollamaStatusBoxError}`}>
                  <div className={styles.ollamaTitle}>
                    <AlertTriangle size={14} />
                    Ollama não detectado
                  </div>
                  
                  {isDownloadingInstaller && installerProgress ? (
                    <div className={styles.downloadProgressWrap} style={{ margin: '8px 0' }}>
                      <div className={styles.downloadProgressMeta}>
                        <span className={styles.downloadProgressMetaDetail}>{installerProgress.message}</span>
                        <span>{installerProgress.percent}%</span>
                      </div>
                      <div className={styles.downloadProgressBar}>
                        <div
                          className={styles.downloadProgressBarFill}
                          style={{ width: `${installerProgress.percent}%` }}
                        />
                      </div>
                      <p className={styles.ollamaText} style={{ marginTop: '4px' }}>
                        Baixando o instalador oficial diretamente. Por favor, aguarde a finalização...
                      </p>
                    </div>
                  ) : installerProgress && installerProgress.status === 'success' ? (
                    <div style={{ margin: '8px 0', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <p className={styles.ollamaText} style={{ color: '#10b981', fontWeight: 600 }}>
                        ✓ {installerProgress.message}
                      </p>
                      <p className={styles.ollamaText}>
                        Siga os passos do instalador nativo que abriu no seu Windows (clique em "Install"). Após concluir, abra o Ollama na barra de tarefas e clique em <strong>Re-checar Conexão</strong> abaixo.
                      </p>
                      <div className={styles.ollamaActions}>
                        <button
                          type="button"
                          className={`${styles.ollamaActionBtn} ${styles.ollamaActionBtnPrimary}`}
                          onClick={checkOllama}
                          disabled={isCheckingOllama}
                        >
                          <RefreshCw size={12} className={isCheckingOllama ? styles.spin : ''} />
                          Re-checar Conexão
                        </button>
                      </div>
                    </div>
                  ) : installerProgress && installerProgress.status === 'error' ? (
                    <div style={{ margin: '8px 0' }}>
                      <p className={styles.ollamaText} style={{ color: '#ef4444', fontWeight: 600 }}>
                        ⚠ {installerProgress.message}
                      </p>
                      <div className={styles.ollamaActions} style={{ marginTop: '8px' }}>
                        <button
                          type="button"
                          className={`${styles.ollamaActionBtn} ${styles.ollamaActionBtnPrimary}`}
                          onClick={handleDownloadInstaller}
                        >
                          Tentar Novamente
                        </button>
                        <button
                          type="button"
                          className={styles.ollamaActionBtn}
                          onClick={() => window.open('https://ollama.com', '_blank')}
                        >
                          <ExternalLink size={12} />
                          Baixar pelo Site
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className={styles.ollamaText}>
                        A IA local avançada precisa que o aplicativo <strong>Ollama</strong> esteja rodando em segundo plano.
                        Você pode baixar e iniciar a instalação dele automaticamente agora mesmo.
                      </p>
                      <div className={styles.ollamaActions}>
                        <button
                          type="button"
                          className={`${styles.ollamaActionBtn} ${styles.ollamaActionBtnPrimary}`}
                          onClick={handleDownloadInstaller}
                          disabled={isDownloadingInstaller}
                        >
                          <Download size={12} />
                          Instalar Ollama Automaticamente
                        </button>
                        <button
                          type="button"
                          className={styles.ollamaActionBtn}
                          onClick={() => window.open('https://ollama.com', '_blank')}
                        >
                          <ExternalLink size={12} />
                          Baixar pelo Site
                        </button>
                        <button
                          type="button"
                          className={styles.ollamaActionBtn}
                          onClick={checkOllama}
                          disabled={isCheckingOllama}
                        >
                          <RefreshCw size={12} className={isCheckingOllama ? styles.spin : ''} />
                          Re-checar Conexão
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Caso 3: Ollama conectado, mas sem o modelo de visão */}
              {ollamaStatus && ollamaStatus.running && !ollamaStatus.has_model && !isDownloading && (
                (() => {
                  const isOutdated = isOllamaVersionOutdated(ollamaStatus.version);
                  if (isOutdated) {
                    return (
                      <div className={`${styles.ollamaStatusBox} ${styles.ollamaStatusBoxError}`}>
                        <div className={styles.ollamaTitle}>
                          <AlertTriangle size={14} />
                          Versão do Ollama Desatualizada (v{ollamaStatus.version})
                        </div>
                        <p className={styles.ollamaText}>
                          Sua versão do Ollama é muito antiga para rodar o modelo visual <strong>qwen2.5-vl</strong>. 
                          O modelo requer pelo menos a versão <strong>0.5.7</strong> do Ollama. 
                          Por favor, atualize o Ollama para a versão mais recente para prosseguir.
                        </p>
                        
                        {isDownloadingInstaller && installerProgress ? (
                          <div className={styles.downloadProgressWrap} style={{ margin: '8px 0' }}>
                            <div className={styles.downloadProgressMeta}>
                              <span className={styles.downloadProgressMetaDetail}>{installerProgress.message}</span>
                              <span>{installerProgress.percent}%</span>
                            </div>
                            <div className={styles.downloadProgressBar}>
                              <div
                                className={styles.downloadProgressBarFill}
                                style={{ width: `${installerProgress.percent}%` }}
                              />
                            </div>
                          </div>
                        ) : installerProgress && installerProgress.status === 'success' ? (
                          <div style={{ margin: '8px 0' }}>
                            <p className={styles.ollamaText} style={{ color: '#10b981', fontWeight: 600 }}>
                              ✓ {installerProgress.message}
                            </p>
                            <p className={styles.ollamaText}>
                              Execute o instalador oficial e siga as instruções na tela do Windows. Após finalizar, abra o Ollama e clique em <strong>Re-checar Conexão</strong>.
                            </p>
                          </div>
                        ) : (
                          <div className={styles.ollamaActions}>
                            <button
                              type="button"
                              className={`${styles.ollamaActionBtn} ${styles.ollamaActionBtnPrimary}`}
                              onClick={handleDownloadInstaller}
                              disabled={isDownloadingInstaller}
                            >
                              <Download size={12} />
                              Atualizar Ollama Automaticamente
                            </button>
                            <button
                              type="button"
                              className={styles.ollamaActionBtn}
                              onClick={() => window.open('https://ollama.com', '_blank')}
                            >
                              <ExternalLink size={12} />
                              Baixar pelo Site
                            </button>
                            <button
                              type="button"
                              className={styles.ollamaActionBtn}
                              onClick={checkOllama}
                              disabled={isCheckingOllama}
                            >
                              <RefreshCw size={12} className={isCheckingOllama ? styles.spin : ''} />
                              Re-checar Conexão
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  }
                  
                  return (
                    <div className={`${styles.ollamaStatusBox} ${styles.ollamaStatusBoxWarning}`}>
                      <div className={styles.ollamaTitle}>
                        <Cpu size={14} />
                        Ollama conectado, mas falta baixar o Modelo de IA
                      </div>
                      <p className={styles.ollamaText}>
                        Detectamos o Ollama rodando! Porém, é necessário fazer o download do modelo visual <strong>qwen2.5-vl</strong> (aprox. 4.5 GB) para sua máquina. Este download ocorre uma única vez e roda 100% offline e privado.
                      </p>
                      <div className={styles.ollamaActions}>
                        <button
                          type="button"
                          className={`${styles.ollamaActionBtn} ${styles.ollamaActionBtnPrimary}`}
                          onClick={handleDownloadModel}
                        >
                          <Download size={12} />
                          Instalar Modelo de IA (4.5 GB)
                        </button>
                        <button
                          type="button"
                          className={styles.ollamaActionBtn}
                          onClick={checkOllama}
                          disabled={isCheckingOllama}
                        >
                          <RefreshCw size={12} className={isCheckingOllama ? styles.spin : ''} />
                          Atualizar
                        </button>
                      </div>
                    </div>
                  );
                })()
              )}

              {/* Caso 4: Download em progresso */}
              {isDownloading && downloadStatus && (
                <div className={`${styles.ollamaStatusBox} ${styles.ollamaStatusBoxWarning}`}>
                  <div className={styles.ollamaTitle}>
                    <RefreshCw size={14} className={styles.spin} />
                    Baixando Modelo de IA
                  </div>
                  <div className={styles.downloadProgressWrap}>
                    <div className={styles.downloadProgressMeta}>
                      <span className={styles.downloadProgressMetaDetail}>{downloadStatus.message}</span>
                      <span>{downloadStatus.percent}%</span>
                    </div>
                    <div className={styles.downloadProgressBar}>
                      <div
                        className={styles.downloadProgressBarFill}
                        style={{ width: `${downloadStatus.percent}%` }}
                      />
                    </div>
                  </div>
                  <p className={styles.ollamaText}>
                    Este download pode levar alguns minutos dependendo de sua conexão de internet. Por favor, mantenha esta tela ativa.
                  </p>
                </div>
              )}

              {/* Caso 5: Tudo pronto e integrado */}
              {ollamaStatus && ollamaStatus.running && ollamaStatus.has_model && !isDownloading && (
                <div className={`${styles.ollamaStatusBox} ${styles.ollamaStatusBoxSuccess}`}>
                  <div className={styles.ollamaTitle}>
                    <CheckCircle size={14} />
                    IA Local Pronta e Ativa!
                  </div>
                  <p className={styles.ollamaText}>
                    O modelo <strong>Qwen2.5-VL</strong> está carregado no Ollama v{ollamaStatus.version || 'local'}.
                    A triagem agora usará aceleração por hardware local (GPU/DirectML se suportado) com alta precisão e 100% de privacidade para suas fotos.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Progresso Geral de Análise do Catálogo */}
          {(isRunning || hasResult) && (
            <div className={styles.analysisProgressWrap} style={{ marginTop: '12px' }}>
              <div className={styles.analysisProgressMeta}>
                <span style={{ fontWeight: 500, fontSize: '0.72rem' }}>Progresso da Triagem do Catálogo</span>
                <span>{status?.processed ?? 0} / {status?.total ?? 0} fotos ({Math.round(progress)}%)</span>
              </div>
              <div className={styles.analysisProgressTrack}>
                <div className={styles.analysisProgressFill} style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {/* Resultado final */}
          {!isRunning && status?.result && (
            <div className={styles.analysisResult} style={{ marginTop: '8px', padding: '6px 0', display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>
                Último resultado obtido em {status.finished_at ? new Date(status.finished_at * 1000).toLocaleString('pt-BR') : 'análise recente'}:
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                · {status.result.processed_files} foto{status.result.processed_files !== 1 ? 's' : ''} processada{status.result.processed_files !== 1 ? 's' : ''}.
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                · {status.result.updated_faces} registro{status.result.updated_faces !== 1 ? 's' : ''} de item atualizado{status.result.updated_faces !== 1 ? 's' : ''} no banco de dados.
              </span>
              <span style={{ color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                · Tecnologia: 
                <span className={styles.badgeReady} style={{ background: 'transparent', padding: 0, border: 'none', color: status.result.source === 'qwen2.5-vl' ? '#10b981' : 'var(--text-label)' }}>
                  {status.result.source === 'qwen2.5-vl' ? 'Modo Ultra (IA local Qwen2.5-VL)' : 'Modo Padrão (Heurísticas HSV)'}
                </span>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

