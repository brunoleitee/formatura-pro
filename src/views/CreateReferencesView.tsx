import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Fingerprint, FolderOpen, Play, RefreshCw, CheckCircle2, AlertTriangle,
  ChevronRight, Sparkles, ImagePlus,
} from 'lucide-react';
import { api, type CreateReferencesStatus } from '../services/api';
import { useApp } from '../context/AppContext';
import styles from './CreateReferencesView.module.css';

const POLL_INTERVAL_MS = 700;

function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m === 0) return `${rem}s`;
  return `${m}m ${rem.toString().padStart(2, '0')}s`;
}

export default function CreateReferencesView() {
  const { currentCatalog } = useApp();
  const [folder, setFolder] = useState('');
  const [status, setStatus] = useState<CreateReferencesStatus | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastResultSeenRef = useRef<boolean>(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const stopTicking = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.getCreateReferencesStatus();
      setStatus(s);
      if (!s.is_running) {
        stopPolling();
        stopTicking();
        // Disparar toast só na primeira transição running → done
        if (s.result && !lastResultSeenRef.current) {
          lastResultSeenRef.current = true;
          setToast({
            kind: 'success',
            message: `${s.result.created_count} referência${s.result.created_count !== 1 ? 's' : ''} criada${s.result.created_count !== 1 ? 's' : ''} com sucesso.`,
          });
        } else if (s.error && !lastResultSeenRef.current) {
          lastResultSeenRef.current = true;
          setToast({ kind: 'error', message: s.error });
        }
      }
    } catch (err) {
      console.error('[create-references] erro ao buscar status:', err);
    }
  }, [stopPolling, stopTicking]);

  // Status inicial — se o backend já está rodando uma execução, retomamos o poll.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.getCreateReferencesStatus();
        if (cancelled) return;
        setStatus(s);
        if (s.is_running) {
          lastResultSeenRef.current = false;
          startPolling();
        } else if (s.result) {
          lastResultSeenRef.current = true; // já vimos esse resultado
        }
      } catch { /* silent */ }
    })();
    return () => {
      cancelled = true;
      stopPolling();
      stopTicking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(refreshStatus, POLL_INTERVAL_MS);
  }, [refreshStatus, stopPolling]);

  const startTicking = useCallback(() => {
    stopTicking();
    setElapsedSec(0);
    const t0 = Date.now();
    tickRef.current = setInterval(() => {
      setElapsedSec((Date.now() - t0) / 1000);
    }, 1000);
  }, [stopTicking]);

  const handlePickFolder = useCallback(async () => {
    try {
      const res = await api.selectFolder();
      if (res?.path) setFolder(res.path);
    } catch (err) {
      console.error('[create-references] selectFolder:', err);
    }
  }, []);

  const handleStart = useCallback(async () => {
    const folderTrimmed = folder.trim();
    if (!folderTrimmed || isStarting) return;
    if (status?.is_running) return;
    setIsStarting(true);
    setToast(null);
    lastResultSeenRef.current = false;
    try {
      const res = await api.createReferences(folderTrimmed, currentCatalog || undefined);
      if (res.status === 'started' || res.status === 'already_running') {
        startTicking();
        startPolling();
        refreshStatus();
      } else {
        setToast({ kind: 'error', message: 'Resposta inesperada do servidor.' });
      }
    } catch (err: any) {
      console.error('[create-references] start failed:', err);
      const msg = err?.message || 'Falha ao iniciar processamento.';
      setToast({ kind: 'error', message: msg });
    } finally {
      setIsStarting(false);
    }
  }, [folder, isStarting, status?.is_running, currentCatalog, refreshStatus, startPolling, startTicking]);

  const isRunning = Boolean(status?.is_running);
  const total = status?.total ?? 0;
  const processed = status?.processed ?? 0;
  const progressPct = isRunning
    ? Math.round((status?.progress ?? 0) * 100)
    : status?.result
      ? 100
      : 0;
  const createdCount = status?.result?.created_count ?? 0;
  const canStart = folder.trim().length > 0 && !isRunning && !isStarting;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.breadcrumbs}>
          <span>Ferramentas</span>
          <ChevronRight size={11} />
          <span className={styles.breadcrumbsActive}>Criar Referências</span>
        </div>
        <h1 className={styles.title}>
          <Fingerprint size={20} />
          Criar Referências Automatizadas
        </h1>
        <p className={styles.subtitle}>
          Aponte para uma pasta com fotos de fichas de ID. O sistema usa OCR + detecção facial para encontrar o número
          do formando em cada ficha, recorta o rosto e salva em <strong>#referencia</strong> com o ID como nome — pronto
          para o scanner reconhecer.
        </p>
      </div>

      <div className={styles.scroll}>
        {/* Instruções */}
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>
            <Sparkles size={14} />
            Como funciona
          </h2>
          <p className={styles.cardText}>
            Cada foto da pasta é avaliada por dois sinais combinados:
          </p>
          <ul className={styles.infoList}>
            <li>Detecção facial — apenas fotos com pelo menos 1 rosto detectado são consideradas.</li>
            <li>OCR híbrido — extrai o número de matrícula da ficha (3 ou mais dígitos).</li>
            <li>Quando ambos batem, o rosto é recortado com margem e salvo como <strong>&lt;id&gt;.jpg</strong>.</li>
            <li>Subpastas (turmas) são preservadas dentro de <strong>#referencia</strong> para o loader identificar turma pelo caminho.</li>
          </ul>
        </div>

        {/* Seleção da pasta */}
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>
            <FolderOpen size={14} />
            Pasta de fotos de ID
          </h2>
          <div className={styles.folderRow}>
            <input
              className={`${styles.folderInput} ${!folder ? styles.folderInputEmpty : ''}`}
              type="text"
              placeholder="Selecione ou cole o caminho da pasta com as fichas..."
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              disabled={isRunning || isStarting}
              spellCheck={false}
            />
            <button
              type="button"
              className={styles.btn}
              onClick={handlePickFolder}
              disabled={isRunning || isStarting}
            >
              <FolderOpen size={13} />
              Escolher
            </button>
          </div>
          <div className={styles.actionRow}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={handleStart}
              disabled={!canStart}
            >
              {isStarting || isRunning ? <RefreshCw size={13} className={styles.spinning} /> : <Play size={13} />}
              {isRunning ? 'Processando...' : isStarting ? 'Iniciando...' : 'Iniciar Processamento'}
            </button>
          </div>
        </div>

        {/* Progresso */}
        {(isRunning || status?.result || status?.error) && (
          <div className={styles.card}>
            <h2 className={styles.cardTitle}>
              <ImagePlus size={14} />
              Progresso
            </h2>
            <div className={styles.progressWrap}>
              <div className={styles.progressMeta}>
                <span>{status?.status_text || (isRunning ? 'Processando...' : 'Concluído')}</span>
                <span className={styles.progressMetaPercent}>{progressPct}%</span>
              </div>
              <div className={styles.progressTrack}>
                <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
              </div>
            </div>
            <div className={styles.statRow}>
              <div className={styles.stat}>
                <span className={styles.statLabel}>Processadas</span>
                <span className={styles.statValue}>{processed}{total > 0 ? ` / ${total}` : ''}</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}>Tempo decorrido</span>
                <span className={styles.statValue}>{formatElapsed(elapsedSec)}</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}>Referências criadas</span>
                <span className={`${styles.statValue} ${styles.statValueSuccess}`}>{createdCount}</span>
              </div>
            </div>
          </div>
        )}

        {/* Toast */}
        {toast && (
          <div className={`${styles.toast} ${toast.kind === 'success' ? styles.toastSuccess : styles.toastError}`}>
            {toast.kind === 'success' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            <span>{toast.message}</span>
          </div>
        )}
      </div>
    </div>
  );
}
