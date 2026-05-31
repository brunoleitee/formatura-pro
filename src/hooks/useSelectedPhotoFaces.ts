import { useState, useEffect, useRef } from 'react';
import { api } from '../services/api';

export interface SelectedPhotoFaceItem {
  id: string;
  thumbnail: string;
  suggestedName: string;
  confidence: number;
  badge: 'ia' | 'similar' | 'sem_match';
}

export interface SelectedPhotoFacesState {
  status: 'waiting' | 'processing' | 'done';
  faces: SelectedPhotoFaceItem[];
}

export function useSelectedPhotoFaces(selectedPhotoPath: string) {
  const [selectedPhotoFaces, setSelectedPhotoFaces] = useState<SelectedPhotoFacesState>({
    status: 'waiting',
    faces: [],
  });

  const lastSelectedPathRef = useRef('');

  useEffect(() => {
    if (!selectedPhotoPath) {
      if (lastSelectedPathRef.current !== '') {
        lastSelectedPathRef.current = '';
        setSelectedPhotoFaces(prev => {
          if (prev.status === 'waiting' && prev.faces.length === 0) return prev;
          return { status: 'waiting', faces: [] };
        });
      }
      return;
    }

    if (lastSelectedPathRef.current === selectedPhotoPath) return;
    lastSelectedPathRef.current = selectedPhotoPath;

    const controller = new AbortController();

    const fetchFaces = () => {
      api.previewFaces(selectedPhotoPath)
        .then(result => {
          if (controller.signal.aborted) return;
          if (!result.ok || !result.faces?.length) {
            setSelectedPhotoFaces(prev =>
              prev.status === 'processing' ? { status: 'waiting', faces: [] } : prev
            );
            return;
          }
          setSelectedPhotoFaces({
            status: 'done',
            faces: result.faces.map((f: any, i: number) => ({
              id: `face-${i}-${Date.now()}`,
              thumbnail: api.faceThumbUrl(selectedPhotoPath, f.bbox[0], f.bbox[1], f.bbox[2], f.bbox[3], 80),
              suggestedName: 'Desconhecido',
              confidence: f.confidence * 100,
              badge: 'sem_match' as const,
            })),
          });
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSelectedPhotoFaces(prev =>
              prev.status === 'processing' ? { status: 'waiting', faces: [] } : prev
            );
          }
        });
    };

    setSelectedPhotoFaces({ status: 'processing', faces: [] });
    fetchFaces();

    return () => {
      controller.abort();
    };
  }, [selectedPhotoPath]);

  return {
    selectedPhotoFaces,
    setSelectedPhotoFaces,
  };
}
