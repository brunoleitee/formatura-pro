export interface CatalogMeta { created_at: string; updated_at: string; }
export interface CatalogsResponse {
  current: string;
  catalogs: string[];
  catalog_meta: Record<string, CatalogMeta>;
}

export interface Person {
  id: string;
  name: string;
  total_photos: number;
  cover_path: string | null;
  cover_box: [number, number, number, number] | null;
}

export interface PhotoFace {
  rowid: number;
  aluno_id: string;
  x1: number; y1: number; x2: number; y2: number;
}

export interface Photo {
  path: string;
  name: string;
  type: string;
  size: number | null;
  mtime: number | null;
  ctime: number | null;
  width?: number | null;
  height?: number | null;
  faces: PhotoFace[];
  total_faces_in_db: number;
  discarded: boolean;
  blur_score: number | null;
  blur_status: string | null;
  blur_label: string | null;
  closed_eyes: boolean;
}

export interface ScanStatus {
  is_scanning: boolean;
  progress: number;
  status_text: string;
  total_processadas: number;
  total_matches: number;
  total_files: number;
  eta_seconds: number;
  device: string;
  scan_summary: unknown | null;
}

export interface ExportStatus {
  is_exporting: boolean;
  progress: number;
  status_text: string;
  total_files: number;
  processed_files: number;
  eta_seconds: number;
  export_summary: unknown | null;
}

export interface GraduationAnalysisStatus {
  is_running: boolean;
  running?: boolean;
  progress: number;
  processed: number;
  total: number;
  updated?: number;
  status_text: string;
  catalog: string;
  result: {
    catalog: string;
    processed_files: number;
    updated?: number;
    updated_faces: number;
    source_table?: string;
    source: string;
  } | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export interface QualitySettings {
  blur_blurry_threshold: number;
  blur_attention_threshold: number;
  min_photos_per_person: number;
  manual_search_min_score: number;
}

export interface AppSettings {
  auto_backup: boolean;
  backup_interval_hours: number;
  [key: string]: unknown;
}

export interface UnknownCluster {
  cluster_id: string;
  faces: ClusterFace[];
  size: number;
}

export interface ClusterFace {
  rowid: number;
  foto_path: string;
  x1: number; y1: number; x2: number; y2: number;
  aluno_id: string;
}

export interface RichClusterFace {
  rowid: number;
  path: string;
  box: [number, number, number, number];
  aluno_id: string;
  blur_status?: string | null;
  blur_score?: number | null;
  closed_eyes?: boolean;
  has_gown?: boolean;
  has_diploma?: boolean;
  has_sash?: boolean;
  has_cap?: boolean;
  face_front_score?: number | null;
  graduation_score?: number | null;
  is_representative?: boolean;
}

export interface RichCluster {
  cluster_id: string;
  cluster_number: number;
  face_count: number;
  photo_count: number;
  total_photos?: number;
  cohesion_score: number;
  cohesion?: number;
  priority_score?: number;
  graduation_tags?: string[];
  has_gown?: boolean;
  has_diploma?: boolean;
  has_sash?: boolean;
  has_cap?: boolean;
  gown_confidence?: number;
  diploma_confidence?: number;
  sash_confidence?: number;
  cap_confidence?: number;
  graduation_reviewed?: boolean;
  manual_graduation_tags?: string[];
  debug_graduation_source?: string;
  preview_image?: string;
  discovered_at?: string;
  representative: RichClusterFace;
  faces: RichClusterFace[];
}

export interface UnknownClustersResponse {
  clusters: RichCluster[];
  threshold: number;
  min_cluster_size: number;
}

export interface Stats {
  total_photos: number;
  total_people: number;
  total_occurrences: number;
  unknown_count: number;
  [key: string]: unknown;
}

export interface SearchResult { name: string; catalog: string; }
