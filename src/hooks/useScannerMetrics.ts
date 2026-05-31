import { useState, useEffect, useRef } from 'react';
import { api } from '../services/api';

export interface SystemMetricsData {
  cpuPercent: number | null;
  ramUsedGb: number | null;
  ramPercent: number | null;
  gpuPercent: number | null;
  temperatureC: number | null;
  cpuTemperatureC: number | null;
  status?: string;
  metricsWarning?: string;
}

export function useScannerMetrics(onMetricsError?: (msg: string) => void) {
  const [systemMetrics, setSystemMetrics] = useState<SystemMetricsData | null>(null);
  const metricsPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let metricsDelay = 2000;
    let metricsFails = 0;
    const MAX_METRICS_FAILS = 3;
    let metricsActive = true;

    const pollMetrics = async () => {
      if (!metricsActive) return;
      try {
        const m = await api.getSystemMetrics() as SystemMetricsData | null;
        metricsFails = 0;
        metricsDelay = 2000;
        setSystemMetrics(m);
      } catch (err) {
        metricsFails++;
        if (metricsFails >= MAX_METRICS_FAILS) {
          metricsActive = false;
          return;
        }
        if (metricsFails === 1 && onMetricsError) {
          onMetricsError(`Erro ao buscar métricas: ${err instanceof Error ? err.message : 'desconhecido'}`);
        }
        metricsDelay = Math.min(metricsDelay * 2, 30000);
      }
      if (metricsActive) {
        metricsPollRef.current = setTimeout(pollMetrics, metricsDelay);
      }
    };

    pollMetrics();

    return () => {
      metricsActive = false;
      if (metricsPollRef.current) {
        clearTimeout(metricsPollRef.current);
      }
    };
  }, [onMetricsError]);

  return {
    systemMetrics,
  };
}
