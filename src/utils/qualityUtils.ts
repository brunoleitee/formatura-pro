import type { Photo } from '../services/api';

export function isPhotoBlurry(photo: Photo): boolean {
  return photo.blur_label === 'Possivelmente desfocada' || photo.blur_label === 'blurry';
}

export function isPhotoAttention(photo: Photo): boolean {
  return photo.blur_label === 'Atenção' || photo.blur_label === 'attention';
}
