import type { Person } from '../services/api/types';
import { faceThumb } from '../components/review/FaceCard';
import { getAvatarThumbUrl } from './imageUrls';

/**
 * Resolve a melhor URL de avatar para uma pessoa.
 * Tier 1: Crop facial da foto de capa (se cover_box disponível)
 * Tier 2: Thumbnail de face cache (avatar_path)
 * Tier 3: Thumbnail da foto inteira (cover_path)
 */
export function resolveAvatarUrl(person: Person, size = 200): string {
  if (person.cover_path && person.cover_box) {
    return faceThumb(person.cover_path, person.cover_box, size);
  }
  if (person.avatar_path) return getAvatarThumbUrl(person.avatar_path);
  return getAvatarThumbUrl(person.cover_path || '');
}
