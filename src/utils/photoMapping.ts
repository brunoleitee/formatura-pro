import type { Photo, PhotoFace } from '../services/api';

export function normalizePersonId(value: any): string {
  return String(value ?? '').trim().toLowerCase();
}

export function isKnownFace(face: PhotoFace | undefined | null): boolean {
  if (!face) return false;
  const id = normalizePersonId(face.aluno_id);
  
  if (!id) return false;
  if (id === 'unknown') return false;
  if (id === 'desconhecido') return false;
  if (id === 'sem_nome') return false;
  if (id === 'sem rostos') return false;
  if (id === 'sem_rostos') return false;
  if (id === 'nao_mapeado') return false;
  if (id === 'não_mapeado') return false;
  if (id === '__unknown__') return false;
  
  // Excluir Pessoa1, Pessoa 2, etc.
  if (/^pessoa\s*\d+$/i.test(String(face.aluno_id ?? '').trim())) return false;
  
  return true;
}

export function isPhotoMapped(photo: Photo): boolean {
  return Array.isArray(photo.faces) && photo.faces.some(isKnownFace);
}

export function isPhotoUnmapped(photo: Photo): boolean {
  return !isPhotoMapped(photo);
}
