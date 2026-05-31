import { API_BASE } from '../services/api/core';

const RAW_EXTENSIONS = ['.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.raf', '.srw', '.x3f'];

function buildThumbUrl(path: string | null | undefined, size: number, q?: number) {
  if (!path) return null;
  const qStr = q != null ? `&q=${q}` : '';
  return `${API_BASE}/image_thumb?path=${encodeURIComponent(path)}&size=${size}${qStr}`;
}

function buildPreviewUrl(path: string | null | undefined, size: number) {
  if (!path) return null;
  return `${API_BASE}/image_preview?path=${encodeURIComponent(path)}&size=${size}`;
}

export function getAvatarThumbUrl(path: string | null | undefined) {
  return buildThumbUrl(path, 160);
}

export function getGridThumbUrl(path: string | null | undefined, size = 400, q?: number) {
  return buildThumbUrl(path, size, q);
}

export function getGridHighThumbUrl(path: string | null | undefined, size = 1000) {
  return buildThumbUrl(path, size);
}

export function getViewerPreviewUrl(path: string | null | undefined, size = 1920) {
  return buildPreviewUrl(path, size);
}

export function getFaceThumbUrl(path: string, box: [number, number, number, number], size: number, expand = 0.38) {
  return `${API_BASE}/thumb?path=${encodeURIComponent(path)}&x1=${box[0]}&y1=${box[1]}&x2=${box[2]}&y2=${box[3]}&size=${size}&expand=${expand}`;
}
