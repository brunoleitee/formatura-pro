import type { Photo, PhotoFace } from '../../services/api';

export function isKnownFace(face: PhotoFace | undefined | null): boolean {
  if (!face) return false;
  const id = String(face.aluno_id ?? '').trim().toLowerCase();
  return Boolean(
    id &&
    id !== 'unknown' &&
    id !== 'desconhecido' &&
    id !== 'sem_nome' &&
    id !== 'nao_mapeado' &&
    id !== 'não_mapeado' &&
    id !== '__unknown__'
  );
}

export function isPhotoMapped(photo: Photo): boolean {
  return Array.isArray(photo.faces) && photo.faces.some(isKnownFace);
}

export function isPhotoUnmapped(photo: Photo): boolean {
  return !isPhotoMapped(photo);
}
