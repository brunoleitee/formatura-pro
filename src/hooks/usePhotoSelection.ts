import React, { useState, useCallback } from 'react';
import type { Photo } from '../services/api';

export function usePhotoSelection(photos: Photo[]) {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const toggleSelection = useCallback((photo: Photo, event: React.MouseEvent | React.KeyboardEvent) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      const path = photo.path;

      if (event.ctrlKey || event.metaKey) {
        if (next.has(path)) next.delete(path);
        else next.add(path);
      } else if (event.shiftKey && prev.size > 0) {
        // Implementação básica de shift-click: seleciona do último selecionado até o atual
        // Para simplificar, vamos apenas adicionar o intervalo se houver fotos ordenadas
        const allPaths = photos.map(p => p.path);
        const lastSelectedPath = Array.from(prev).pop()!;
        const startIdx = allPaths.indexOf(lastSelectedPath);
        const endIdx = allPaths.indexOf(path);
        
        if (startIdx !== -1 && endIdx !== -1) {
          const [low, high] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          for (let i = low; i <= high; i++) {
            next.add(allPaths[i]);
          }
        } else {
          next.add(path);
        }
      } else {
        // Clique simples: limpa outros e seleciona apenas este (ou desseleciona se já era o único)
        if (next.has(path) && next.size === 1) {
          next.clear();
        } else {
          next.clear();
          next.add(path);
        }
      }
      return next;
    });
  }, [photos]);

  const clearSelection = useCallback(() => setSelectedPaths(new Set()), []);

  return {
    selectedPaths,
    setSelectedPaths,
    toggleSelection,
    clearSelection
  };
}
