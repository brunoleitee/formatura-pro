import type { Photo, PhotoFace } from '../services/api';

export function normalizePersonId(value: any) {
  return String(value ?? '').trim();
}

export function isTemporaryPersonId(value: any) {
  const raw = normalizePersonId(value);
  const id = raw.toLowerCase();

  if (!id) return true;
  if (id === 'unknown') return true;
  if (id === 'desconhecido') return true;
  if (id === 'sem_nome') return true;
  if (id === 'nao_mapeado') return true;
  if (id === 'não_mapeado') return true;
  if (id === '__unknown__') return true;
  if (/^pessoa\s*\d+$/i.test(raw)) return true;
  return false;
}

export function isKnownPersonId(value: any) {
  return !isTemporaryPersonId(value);
}

export function isKnownFace(face: PhotoFace | undefined | null) {
  return isKnownPersonId(face?.aluno_id);
}

export function isUnknownFace(face: PhotoFace | undefined | null) {
  return !isKnownFace(face);
}

export function isPhotoMapped(photo: Photo) {
  return Array.isArray(photo.faces) && photo.faces.some(isKnownFace);
}

export function isPhotoUnmapped(photo: Photo) {
  return !isPhotoMapped(photo);
}
