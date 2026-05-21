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
  thumbnailUrl?: string;
  parentId?: string;
};

export type CloudFolderInsight = {
  photoCount?: number;
  subfolderCount?: number;
  referenceDetected?: boolean;
};

export type CloudCatalogMode = 'catalog' | 'face' | 'full';

export type CloudEventDraft = {
  id?: string;
  name: string;
  provider: 'google_drive';
  sourceFolderId: string;
  sourceFolderName: string;
  references: string[];
  totalFiles: number;
  subfolderCount?: number;
  mode: CloudCatalogMode;
  status: 'draft' | 'indexed' | 'processing' | 'ready';
  createdAt?: string;
};

export type CloudProviderSummary = {
  provider: CloudProvider;
  name: string;
  enabled: boolean;
  functional: boolean;
};
