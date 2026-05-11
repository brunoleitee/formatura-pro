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

function findScrollableParent(node: HTMLElement | null): HTMLElement | null {
  if (!node) return null;
  if (node.scrollHeight > node.clientHeight) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return node;
    }
  }
  return findScrollableParent(node.parentElement);
}

export function useDragSelection<T extends { rowid: number }>(
  containerRef: React.RefObject<HTMLElement | null>,
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
  const wasDraggingRef = useRef(false);
  const dragTimeoutRef = useRef<number | null>(null);
  const currentMousePosRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const scrollRafRef = useRef<number | null>(null);
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
    const newSelected = (isShiftRef.current || isCtrlRef.current)
      ? new Set(initialSelectedRef.current)
      : new Set<number>();

    for (const item of items) {
      const itemId = getItemId(item);
      const element = getItemElement(itemId);
      if (!element) continue;

      const intersects = elementIntersectsBox(element, box);

      if (intersects) {
        if (isCtrlRef.current) {
          // Ctrl/Cmd: toggle
          if (initialSelectedRef.current.has(itemId)) {
            newSelected.delete(itemId);
          } else {
            newSelected.add(itemId);
          }
        } else {
          // Normal/Shift: add to selection
          newSelected.add(itemId);
        }
      }
    }

    return newSelected;
  }, [items, getItemId, getItemElement, elementIntersectsBox]);

  const updateSelectionFromMouse = useCallback((clientX: number, clientY: number) => {
    if (!startPointRef.current || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const currentPoint: Point = {
      x: clientX - containerRect.left,
      y: clientY - containerRect.top,
    };

    const deltaX = currentPoint.x - startPointRef.current.x;
    const deltaY = currentPoint.y - startPointRef.current.y;
    const dragDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    if (dragDistance >= minDragPixels) {
      wasDraggingRef.current = true;
    }

    // Only show selection box if dragging more than minimum pixels
    if (!wasDraggingRef.current) {
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

  const scrollLoop = useCallback(() => {
    if (!currentMousePosRef.current || !containerRef.current || !startPointRef.current) {
      scrollRafRef.current = null;
      return;
    }

    if (wasDraggingRef.current) {
      const scrollContainer = findScrollableParent(containerRef.current);
      if (scrollContainer) {
        const scrollRect = scrollContainer.getBoundingClientRect();
        const { clientY, clientX } = currentMousePosRef.current;
        
        let scrollDelta = 0;
        const EDGE_THRESHOLD = 80;
        const MAX_SCROLL_SPEED = 18;

        if (clientY < scrollRect.top + EDGE_THRESHOLD) {
          const intensity = Math.max(0, 1 - (clientY - scrollRect.top) / EDGE_THRESHOLD);
          scrollDelta = -intensity * MAX_SCROLL_SPEED;
        } else if (clientY > scrollRect.bottom - EDGE_THRESHOLD) {
          const intensity = Math.max(0, 1 - (scrollRect.bottom - clientY) / EDGE_THRESHOLD);
          scrollDelta = intensity * MAX_SCROLL_SPEED;
        }

        if (scrollDelta !== 0) {
          scrollContainer.scrollTop += scrollDelta;
          updateSelectionFromMouse(clientX, clientY);
        }
      }
    }

    scrollRafRef.current = requestAnimationFrame(scrollLoop);
  }, [containerRef, updateSelectionFromMouse]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!containerRef.current?.contains(e.target as Node)) return;

    // Ignore if clicking on interactive elements
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'BUTTON' ||
      target.tagName === 'INPUT' ||
      target.tagName === 'IMG' ||
      target.closest('button') ||
      target.closest('input') ||
      target.closest('img') ||
      target.closest('[data-interactive]')
    ) {
      return;
    }

    // Only allow left click
    if (e.button !== 0) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const point: Point = {
      x: e.clientX - containerRect.left,
      y: e.clientY - containerRect.top,
    };

    startPointRef.current = point;
    isShiftRef.current = e.shiftKey;
    isCtrlRef.current = e.ctrlKey || e.metaKey;
    initialSelectedRef.current = new Set(selected);
    wasDraggingRef.current = false;
    currentMousePosRef.current = { clientX: e.clientX, clientY: e.clientY };
    
    if (dragTimeoutRef.current) {
      clearTimeout(dragTimeoutRef.current);
      dragTimeoutRef.current = null;
    }
  }, [containerRef, selected]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!startPointRef.current || !containerRef.current) return;
    
    currentMousePosRef.current = { clientX: e.clientX, clientY: e.clientY };
    updateSelectionFromMouse(e.clientX, e.clientY);

    if (!scrollRafRef.current) {
      scrollRafRef.current = requestAnimationFrame(scrollLoop);
    }
  }, [containerRef, updateSelectionFromMouse, scrollLoop]);

  const handleMouseUp = useCallback(() => {
    setSelectionBox(null);
    startPointRef.current = null;
    currentMousePosRef.current = null;
    
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    
    if (wasDraggingRef.current) {
      // Start a timeout to reset wasDraggingRef if click doesn't fire
      if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
      dragTimeoutRef.current = window.setTimeout(() => {
        wasDraggingRef.current = false;
        dragTimeoutRef.current = null;
      }, 50);
    }
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && startPointRef.current) {
      e.preventDefault();
      setSelectionBox(null);
      startPointRef.current = null;
      wasDraggingRef.current = false;
      currentMousePosRef.current = null;
      
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      
      // Reset to initial selection
      setSelected(new Set(initialSelectedRef.current));
    }
  }, [setSelected]);

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);

    // Capture click to prevent default behavior immediately after dragging
    const handleCaptureClick = (e: MouseEvent) => {
      if (wasDraggingRef.current) {
        e.stopPropagation();
        e.preventDefault();
        wasDraggingRef.current = false;
        if (dragTimeoutRef.current) {
          clearTimeout(dragTimeoutRef.current);
          dragTimeoutRef.current = null;
        }
      }
    };
    document.addEventListener('click', handleCaptureClick, true);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('click', handleCaptureClick, true);
      
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, [handleMouseMove, handleMouseUp, handleKeyDown]);

  return {
    isSelecting: selectionBox !== null,
    selectionBox,
    handleMouseDown,
  };
}
