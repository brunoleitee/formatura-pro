import { useState, useEffect } from 'react';

export function useLocalStorage<T>(key: string, defaultValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === null) return defaultValue;
      try {
        return JSON.parse(stored) as T;
      } catch {
        // existing data stored as plain string (pre-hook migration)
        return stored as unknown as T;
      }
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // private browsing or storage quota exceeded
    }
  }, [key, value]);

  return [value, setValue] as const;
}
