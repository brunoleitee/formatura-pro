export interface CatalogMeta { created_at: string; updated_at: string; }
export interface CatalogsResponse {
  current: string;
  catalogs: string[];
  catalog_meta: Record<string, CatalogMeta>;
}

export interface CatalogSettingsResponse {
  catalog: string;
  scan_paths: string[];
  root_path: string;
  selected_folders?: Record<string, string>;
  quality?: Record<string, unknown>;
  scanner?: Record<string, unknown>;
  export?: Record<string, unknown>;
  ui?: Record<string, unknown>;
}

export interface Person {
  id: string;
  name: string;
  class_name: string;
  total_photos: number;
  favorites_count?: number;
  discarded_count?: number;
  avg_quality?: number;
  cover_path: string | null;
  cover_box: [number, number, number, number] | null;
  avatar_path?: string | null;
  sample_photos?: Array<{ path: string; box: [number, number, number, number] }>;
}

export interface PhotoFace {
  rowid: number;
  aluno_id: string;
  x1: number; y1: number; x2: number; y2: number;
  is_foreground?: number;
  foreground_score?: number | null;
  background_penalty_reason?: string | null;
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

export interface PhotoContextResponse {
  current: Photo | null;
  previous: Photo | null;
  next: Photo | null;
  neighbors: Photo[];
  index: number;
  total: number;
  catalog?: string;
  error?: string;
}

export interface ScanRecentFace {
  id: number;
  name: string;
  path: string;
  box: [number, number, number, number];
  confidence: number;
}

export interface ScanSummary {
  time_str?: string;
  total_photos?: number;
  total_faces?: number;
  [key: string]: unknown;
}

export interface SystemMetrics {
  cpuPercent: number | null;
  ramUsedGb: number | null;
  ramPercent: number | null;
  gpuPercent: number | null;
  temperatureC: number | null;
}

export interface LiveScannerStatus {
  running: boolean;
  stopped: boolean;
  processedPhotos: number;
  totalPhotos: number;
  started_at: number | null;
  elapsed_seconds: number | null;
  eta_seconds: number | null;
  avgSecondsPerPhoto: number | null;
  is_scanning: boolean;
  status_text: string;
}

export interface ScanCurrentPhoto {
  path: string;
  name: string;
  preview_url?: string;
  natural_width?: number;
  natural_height?: number;
  faces: { bbox: number[]; confidence: number; name?: string }[];
  timestamp: number;
}

export interface ScanStatus {
  is_scanning: boolean;
  stopped?: boolean;
  progress: number;
  status_text: string;
  total_processadas: number;
  total_faces?: number;
  total_matches: number;
  total_clusters?: number;
  total_files: number;
  total_inserted_files?: number;
  total_existing_files?: number;
  last_folder_scanned?: string;
  eta_seconds: number;
  device: string;
  provider?: string;
  gpu_error?: string;
  skipped_background_faces?: number;
  current_photo?: ScanCurrentPhoto | null;
  current_photo_index?: number;
  duplicate_count?: number;
  duplicate_percent?: number;
  started_at?: number | null;
  recent_faces?: ScanRecentFace[];
  scan_summary: ScanSummary | null;
}

export interface PreviewFace {
  bbox: number[];
  confidence: number;
  area: number;
  is_primary: boolean;
  crop_url: string;
}

export interface PreviewFacesResponse {
  ok: boolean;
  path?: string;
  error?: string;
  faces: PreviewFace[];
}

export interface QualityAuditStatus {
  status: string;
  running: boolean;
  enabled: boolean;
  processed: number;
  total: number;
  progress: number;
  message: string;
  is_auditing: boolean;
  status_text: string;
}

export interface ExportSummary {
  export_id?: string;
  export_dir?: string;
  pdf_path?: string;
  dest_path?: string;
  report_path?: string;
  pdf_report_path?: string;
  time_seconds?: number;
  time_str?: string;
  folder_count?: number;
  photo_count?: number;
  mode?: string;
}

export interface ExportStatus {
  is_exporting: boolean;
  running?: boolean;
  status?: string;
  progress: number;
  status_text: string;
  message?: string;
  total_files: number;
  processed_files: number;
  eta_seconds: number;
  export_id?: string;
  export_dir?: string;
  pdf_path?: string;
  export_summary: ExportSummary | null;
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
  is_foreground?: number;
  foreground_score?: number | null;
  background_penalty_reason?: string | null;
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
  suggested_student?: string | null;
  suggested_similarity?: number | null;
  best_student_debug?: string | null;
  best_similarity_debug?: number | null;
  unknown_similar_id?: string | null;
  unknown_similar_number?: number | null;
  unknown_similar_similarity?: number | null;
  representative: RichClusterFace;
  faces: RichClusterFace[];
}

export interface ReviewClusterSummary {
  cluster_id: string;
  cluster_number: number;
  face_count: number;
  photo_count: number;
  total_photos?: number;
  cohesion_score: number;
  cohesion?: number;
  priority_score?: number;
  suggested_student?: string | null;
  suggested_similarity?: number | null;
  unknown_similar_id?: string | null;
  unknown_similar_number?: number | null;
  unknown_similar_similarity?: number | null;
  best_student_debug?: string | null;
  best_similarity_debug?: number | null;
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
  status?: string;
  aluno_id?: string | null;
  student_name?: string | null;
  nome_formando?: string | null;
  representative: RichClusterFace;
}

export interface UnknownClustersResponse {
  clusters: RichCluster[];
  threshold: number;
  min_cluster_size: number;
}

export interface ReviewClustersPageResponse {
  clusters: ReviewClusterSummary[];
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
  review_ready: boolean;
  cache_used?: boolean;
  total_faces_in_catalog?: number;
  cache_duration_ms?: number;
  query_duration_ms?: number;
}

export interface ReviewClusterDetailResponse {
  cluster: RichCluster;
  review_ready: boolean;
  cache_used?: boolean;
  duration_ms?: number;
}

export interface AssignClusterResponse {
  success: boolean;
  cluster_id: string;
  aluno_id: string | null;
  student_name: string | null;
  class_name?: string | null;
  status: string;
  updated_count: number;
  nome_formando?: string | null;
  ok?: boolean;
  updated?: number;
}

export interface StudentMatchPreviewResponse {
  matched_student_rowid: number;
  matched_student_photo_path: string;
  matched_student_face_box: number[];
  matched_similarity: number;
  matched_student_id: string;
  matched_student_name: string | null;
  matched_student_folder: string;
  matched_student_label: string;
}

export interface Stats {
  total_photos: number;
  total_people: number;
  total_occurrences: number;
  unknown_count: number;
  classes?: {
    class_name: string;
    students_count: number;
    photos_count: number;
    goal_per_student: number;
    target_photos: number;
    average_photos: number;
    completion_percent: number;
  }[];
  [key: string]: unknown;
}

export interface SearchResult { name: string; catalog: string; }

export interface ExplorerPhoto {
  name: string;
  path: string;
  ext: string;
  size: number | null;
  mtime: number | null;
  is_raw: boolean;
  is_video: boolean;
}

export interface ExplorerPhotosResponse {
  ok: boolean;
  error: string;
  path: string;
  total: number;
  photos: ExplorerPhoto[];
}

export interface FolderTreeCounts {
  RAW: number;
  JPG: number;
  PNG: number;
  HEIC: number;
  MOV: number;
}

export interface FolderTreeItem {
  name: string;
  path: string;
  type: string;
  direct_files: number;
  total_files: number;
  has_children: boolean;
  counts: FolderTreeCounts;
  children: FolderTreeItem[];
  camera?: string | null;
}

export interface FolderTreeResponse {
  ok: boolean;
  error: string;
  path: string;
  name: string;
  direct_files: number;
  total_files: number;
  total_photos: number;
  total_raw: number;
  total_jpg: number;
  has_children: boolean;
  children: FolderTreeItem[];
  camera?: string | null;
}

export interface ScannerFolderNode {
  name: string;
  path: string;
  imageCount: number;
  subfolderCount: number;
  children: ScannerFolderNode[];
  hasChildren: boolean;
  isLoading?: boolean;
}

export interface ScannerFolderTreeResponse {
  name: string;
  path: string;
  imageCount: number;
  subfolderCount: number;
  children: ScannerFolderNode[];
  hasChildren: boolean;
  error?: string;
}
