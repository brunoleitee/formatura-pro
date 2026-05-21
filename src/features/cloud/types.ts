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

export type CloudEventDraft = {
  id?: string;
  name: string;
  provider: CloudProvider;
  sourceFolderId: string;
  sourceFolderName: string;
  referencesFolderId?: string;
  referencesFolderName?: string;
  totalFiles?: number;
  status: 'draft' | 'indexed' | 'processing' | 'ready';
};

export type CloudProviderSummary = {
  provider: CloudProvider;
  name: string;
  enabled: boolean;
  functional: boolean;
};
