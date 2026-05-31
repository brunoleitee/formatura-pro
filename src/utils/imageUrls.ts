import { api } from '../services/api';

export function getAvatarThumbUrl(path: string | null | undefined) {
  if (!path) return null;
  return api.thumbUrl(path, 160);
}

export function getGridThumbUrl(path: string | null | undefined, size = 400, q?: number) {
  if (!path) return null;
  return api.thumbUrl(path, size, q);
}

export function getGridHighThumbUrl(path: string | null | undefined, size = 1000) {
  if (!path) return null;
  return api.thumbUrl(path, size);
}

export function getViewerPreviewUrl(path: string | null | undefined, size = 1920) {
  if (!path) return null;
  return api.previewUrl(path, size);
}

export function getFaceThumbUrl(path: string, box: [number, number, number, number], size: number, expand = 0.38) {
  return api.faceThumbUrl(path, box[0], box[1], box[2], box[3], size, expand);
}
