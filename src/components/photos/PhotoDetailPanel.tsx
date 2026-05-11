import { api, type Photo } from '../../services/api';
import { isKnownFace } from '../../utils/photoMapping';

interface PhotoDetailPanelProps {
  photo: Photo;
  onClose: () => void;
}

export function PhotoDetailPanel({ photo, onClose }: PhotoDetailPanelProps) {
  return (
    <div className="photo-detail-panel">
      <div className="photo-detail-header">
        <span>{photo.name}</span>
        <button className="icon-btn" onClick={onClose}>✕</button>
      </div>
      <img
        src={api.thumbUrl(photo.path, 600)}
        alt={photo.name}
        style={{ width: '100%', borderRadius: 8, marginBottom: 12, objectFit: 'contain' }}
      />
      <div className="detail-info">
        <div className="detail-row">
          <span>Tamanho</span>
          <span>{photo.size ? `${(photo.size / 1024).toFixed(0)} KB` : '—'}</span>
        </div>
        <div className="detail-row">
          <span>Qualidade</span>
          <span>{photo.blur_label || '—'}</span>
        </div>
        <div className="detail-row">
          <span>Faces</span>
          <span>{photo.total_faces_in_db}</span>
        </div>
        {photo.faces.filter(isKnownFace).length > 0 && (
          <div className="detail-row">
            <span>Pessoas</span>
            <span>{photo.faces.filter(isKnownFace).map((f) => f.aluno_id).join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
