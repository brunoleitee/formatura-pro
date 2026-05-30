import { API_BASE } from '../services/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';

const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__;

function buildThumbUrl(path: string | null | undefined, size: number, q?: number) {
  if (!path) return null;
  const qStr = q != null ? `&q=${q}` : '';
  
  // Em desenvolvimento, resolve como rota relativa (/api/image_thumb?path=...) servida através do Vite proxy.
  // Em produção, resolve diretamente para o endereço absoluto do backend local (http://127.0.0.1:8000/api/image_thumb?path=...).
  // Isso contorna 100% dos bloqueios de segurança de protocolos e CORS na Webview2 do Windows.
  return `${API_BASE}/image_thumb?path=${encodeURIComponent(path)}&size=${size}${qStr}`;
}

function buildPreviewUrl(path: string | null | undefined, size: number) {
  if (!path) return null;
  
  // Usamos sempre a API local do backend em Python para gerar e cachear uma imagem de alta qualidade
  // otimizada para o tamanho da tela (ex: largura máxima de 1920px). Isso carrega um arquivo JPEG
  // leve de ~300KB a ~500KB em vez de ler e decodificar a foto original de câmera profissional (20MB+),
  // resultando em uma navegação fluida, instantânea e sem engasgos na galeria.
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
  // Corta e redimensiona o rosto usando a API dedicada do backend local em Python.
  return `${API_BASE}/thumb?path=${encodeURIComponent(path)}&x1=${box[0]}&y1=${box[1]}&x2=${box[2]}&y2=${box[3]}&size=${size}&expand=${expand}`;
}
