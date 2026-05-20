import type { Photo, PhotoFace, Person } from '../services/api';

export function normalizePersonId(value: any) {
  return String(value ?? '').trim();
}

const PERSON_KEY_SEP = '::';

export function makePersonKey(params: {
  catalog?: string;
  className?: string;
  referenceFolder?: string;
  studentId?: string;
  personName?: string;
}): string {
  const parts = [
    (params.catalog ?? '').trim(),
    (params.className ?? '').trim(),
    (params.referenceFolder ?? '').trim(),
    (params.studentId ?? params.personName ?? '').trim(),
  ];
  const key = parts.filter(Boolean).join(PERSON_KEY_SEP);
  return key || '__UNKNOWN__';
}

export function formatPersonLabel(person: { name: string; class_name?: string; person_key?: string }): string {
  const cls = person.class_name || '';
  if (cls && cls !== 'Sem turma') {
    return `${person.name} · ${cls}`;
  }
  return person.name;
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
