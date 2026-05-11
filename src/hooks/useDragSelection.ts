import { useRef, useState, useCallback, useEffect } from 'react';
import type React from 'react';

export interface SelectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

export function useDragSelection<T extends { rowid: number }>(
  containerRef: React.RefObject<HTMLElement>,
  getItemId: (item: T) => number,
  selected: Set<number>,
  setSelected: (selected: Set<number>) => void,
  items: T[]
) {
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const startPointRef = useRef<Point | null>(null);
  const initialSelectedRef = useRef<Set<number>>(new Set());
  const isShiftRef = useRef(false);
  const isCtrlRef = useRef(false);
  const minDragPixels = 6;

  const getItemElement = useCallback((itemId: number): HTMLElement | null => {
    const element = document.querySelector(`[data-selectable-card][data-rowid="${itemId}"]`) as HTMLElement;
    return element || null;
  }, []);

  const elementIntersectsBox = useCallback((element: HTMLElement, box: SelectionBox): boolean => {
    const rect = element.getBoundingClientRect();
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return false;

    const relativeRect = {
      left: rect.left - containerRect.left,
      top: rect.top - containerRect.top,
      right: rect.right - containerRect.left,
      bottom: rect.bottom - containerRect.top,
    };

    return !(
      relativeRect.right < box.x ||
      relativeRect.left > box.x + box.width ||
      relativeRect.bottom < box.y ||
      relativeRect.top > box.y + box.height
    );
  }, [containerRef]);

  const calculateSelectedItems = useCallback((box: SelectionBox): Set<number> => {
    const newSelected = new Set(initialSelectedRef.current);

    for (const item of items) {
      const itemId = getItemId(item);
      const element = getItemElement(itemId);
      if (!element) continue;

      const intersects = elementIntersectsBox(element, box);

      if (isCtrlRef.current) {
        // Ctrl/Cmd: toggle
        if (intersects) {
          if (initialSelectedRef.current.has(itemId)) {
            newSelected.delete(itemId);
          } else {
            newSelected.add(itemId);
          }
        }
      } else {
        // Normal: add to selection
        if (intersects) {
          newSelected.add(itemId);
        }
      }
    }

    return newSelected;
  }, [items, getItemId, getItemElement, elementIntersectsBox]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!containerRef.current?.contains(e.target as Node)) return;

    // Ignore if clicking on interactive elements
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'BUTTON' ||
      target.tagName === 'INPUT' ||
      target.closest('button') ||
      target.closest('input') ||
      target.closest('[data-interactive]')
    ) {
      return;
    }

    const containerRect = containerRef.current.getBoundingClientRect();
    const point: Point = {
      x: e.clientX - containerRect.left,
      y: e.clientY - containerRect.top,
    };

    startPointRef.current = point;
    isShiftRef.current = e.shiftKey;
    isCtrlRef.current = e.ctrlKey || e.metaKey;
    initialSelectedRef.current = new Set(selected);
  }, [containerRef, selected]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!startPointRef.current || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const currentPoint: Point = {
      x: e.clientX - containerRect.left,
      y: e.clientY - containerRect.top,
    };

    const deltaX = currentPoint.x - startPointRef.current.x;
    const deltaY = currentPoint.y - startPointRef.current.y;
    const dragDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    // Only show selection box if dragging more than minimum pixels
    if (dragDistance < minDragPixels) {
      setSelectionBox(null);
      return;
    }

    const box: SelectionBox = {
      x: Math.min(startPointRef.current.x, currentPoint.x),
      y: Math.min(startPointRef.current.y, currentPoint.y),
      width: Math.abs(deltaX),
      height: Math.abs(deltaY),
    };

    setSelectionBox(box);

    // Update selected items in real-time
    const newSelected = calculateSelectedItems(box);
    setSelected(newSelected);
  }, [containerRef, calculateSelectedItems, setSelected]);

  const handleMouseUp = useCallback(() => {
    setSelectionBox(null);
    startPointRef.current = null;
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && startPointRef.current) {
      e.preventDefault();
      setSelectionBox(null);
      startPointRef.current = null;
      // Reset to initial selection
      setSelected(new Set(initialSelectedRef.current));
    }
  }, [setSelected]);

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleMouseMove, handleMouseUp, handleKeyDown]);

  return {
    isSelecting,
    selectionBox,
    handleMouseDown,
  };
}
