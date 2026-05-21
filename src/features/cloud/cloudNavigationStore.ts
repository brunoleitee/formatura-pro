export type CloudNavigationState = {
  currentFolderId: string;
  currentPath: string[];
};

export type CloudBreadcrumbItem = {
  id: string;
  name: string;
};

export type CloudNavigationSnapshot = CloudNavigationState & {
  breadcrumb: CloudBreadcrumbItem[];
};

export function createNavigationSnapshot(breadcrumb: CloudBreadcrumbItem[]): CloudNavigationSnapshot {
  const last = breadcrumb[breadcrumb.length - 1];
  return {
    currentFolderId: last?.id || 'root',
    currentPath: breadcrumb.map(item => item.name),
    breadcrumb,
  };
}

export function canGoUp(breadcrumb: CloudBreadcrumbItem[]) {
  return breadcrumb.length > 1;
}

export function parentBreadcrumb(breadcrumb: CloudBreadcrumbItem[]) {
  return canGoUp(breadcrumb) ? breadcrumb.slice(0, -1) : breadcrumb;
}
