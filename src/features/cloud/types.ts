export type CloudProvider = 'google_drive' | 'dropbox' | 'onedrive';

export type CloudConnection = {
  provider: CloudProvider;
  connected: boolean;
  accountEmail?: string;
  status: 'online' | 'offline' | 'disconnected';
};

export type CloudItem = {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  isImage?: boolean;
  thumbnailUrl?: string;
  webContentLink?: string;
  parentId?: string;
  modifiedTime?: string | null;
  size?: number | null;
  photoCount?: number;
  subfolderCount?: number;
  referencesCount?: number;
  referenceDetected?: boolean;
};

export type CloudFolderInsight = {
  photoCount?: number;
  subfolderCount?: number;
  referenceDetected?: boolean;
  referencesCount?: number;
};

export type CloudCatalogSession = {
  currentFolderId: string;
  currentPathJson: Array<{ id: string; name: string }>;
  selectedFolderId: string;
  selectedCatalogId: string;
  scrollPosition: number;
  viewMode: string;
  backStack: Array<{
    currentFolderId: string;
    currentPath: string[];
    breadcrumb: Array<{ id: string; name: string }>;
  }>;
  forwardStack: Array<{
    currentFolderId: string;
    currentPath: string[];
    breadcrumb: Array<{ id: string; name: string }>;
  }>;
  updatedAt?: string | null;
};

export type CloudCatalogAIStatus = {
  success?: boolean;
  catalogId?: string;
  catalogPath?: string;
  cachePath?: string;
  facesCount?: number;
  embeddingsCount?: number;
  clustersCount?: number;
  reviewPendingCount?: number;
  lastProcessedAt?: string | null;
  status?: 'idle' | 'processing' | 'ready' | 'error';
  message?: string;
};

export type CloudCatalogMode = 'catalog' | 'face' | 'full';

export type CloudEventDraft = {
  id?: string;
  source?: 'cloud' | 'local';
  type?: 'cloud';
  name: string;
  provider: 'google_drive';
  sourceFolderId: string;
  sourceFolderName: string;
  eventRootFolderId?: string;
  eventRootFolderName?: string;
  referencesFolderIds?: string[];
  sourceBreadcrumb?: string[];
  references: string[];
  totalFiles: number;
  subfolderCount?: number;
  totalSubfolders?: number;
  referencesCount?: number;
  mode: CloudCatalogMode;
  status: 'draft' | 'indexed' | 'processing' | 'ready';
  createdAt?: string;
  updatedAt?: string;
  catalogPath?: string;
  cachePath?: string;
  embeddingsPath?: string;
  facesDbPath?: string;
  reviewStatePath?: string;
  cacheEnabled?: boolean;
  cacheSize?: number;
  lastSync?: string;
  lastOpenedAt?: string;
  session?: CloudCatalogSession;
  aiStatus?: CloudCatalogAIStatus;
};

export type CloudCatalog = CloudEventDraft & {
  id: string;
  source: 'cloud' | 'local';
  type?: 'cloud';
  cacheEnabled: boolean;
  cacheSize: number;
  lastSync?: string;
  createdAt: string;
  updatedAt: string;
  catalogPath?: string;
  cachePath?: string;
  embeddingsPath?: string;
  facesDbPath?: string;
  reviewStatePath?: string;
  sourceBreadcrumb?: string[];
  totalSubfolders?: number;
  referencesCount?: number;
  lastOpenedAt?: string;
  aiStatus?: CloudCatalogAIStatus;
};

export type CloudProviderSummary = {
  provider: CloudProvider;
  name: string;
  enabled: boolean;
  functional: boolean;
};
