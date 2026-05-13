import { API_BASE } from '../services/api/core';

const PHOTO_SOURCE_BASE = 'http://127.0.0.1:8000';

function buildThumbUrl(path: string | null | undefined, size: number) {
  if (!path) return null;
  return `${API_BASE}/image_thumb?path=${encodeURIComponent(path)}&size=${size}`;
}

function buildPreviewUrl(path: string | null | undefined, size: number) {
  if (!path) return null;
  return `${API_BASE}/image_preview?path=${encodeURIComponent(path)}&size=${size}`;
}

export function buildPhotoSourceUrl(path: string): string {
  return `${PHOTO_SOURCE_BASE}/api/photo-source/full?path=${encodeURIComponent(path)}`;
}

export function getAvatarThumbUrl(path: string | null | undefined) {
  return buildThumbUrl(path, 160);
}

export function getGridThumbUrl(path: string | null | undefined, size = 400) {
  return buildThumbUrl(path, size);
}

export function getGridHighThumbUrl(path: string | null | undefined, size = 1000) {
  return buildThumbUrl(path, size);
}

export function getViewerPreviewUrl(path: string | null | undefined, size = 1920) {
  return buildPreviewUrl(path, size);
}

