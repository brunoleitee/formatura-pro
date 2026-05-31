import { useState, useEffect, useRef } from 'react';

export function useScannerTimer(isScanning: boolean, startedAt: number | undefined | null) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (startedAt) {
      startedAtRef.current = startedAt;
    }
  }, [startedAt]);

  useEffect(() => {
    if (!isScanning || !startedAtRef.current) {
      setElapsedSeconds(0);
      return;
    }
    const tick = () => {
      if (startedAtRef.current) {
        setElapsedSeconds(Math.floor(Date.now() / 1000 - startedAtRef.current));
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isScanning]);

  return {
    elapsedSeconds,
    setElapsedSeconds,
  };
}
