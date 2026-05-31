import { useReducer, useEffect, useRef, useMemo } from 'react';
import { api, type Photo, type Person, type Stats, type ScanStatus, type ReviewClustersPageResponse, type CatalogFolderStats } from '../services/api';
import { computeDashboardMetrics } from '../utils/dashboardMetrics';

interface DashboardState {
  photos: Photo[];
  people: Person[];
  stats: Stats | null;
  scanStatus: ScanStatus | null;
  clusters: ReviewClustersPageResponse | null;
  folderStats: CatalogFolderStats | null;
  loading: boolean;
  loadedOnce: boolean;
  error: string;
}

type DashboardAction =
  | { type: 'FETCH_START' }
  | {
      type: 'FETCH_SUCCESS';
      payload: {
        stats: Stats;
        photos: Photo[];
        people: Person[];
        scanStatus: ScanStatus | null;
        clusters: ReviewClustersPageResponse | null;
        folderStats: CatalogFolderStats | null;
      };
    }
  | { type: 'FETCH_ERROR'; payload: string }
  | { type: 'RESET'; payload: { loadedOnce: boolean } };

const initialState: DashboardState = {
  photos: [],
  people: [],
  stats: null,
  scanStatus: null,
  clusters: null,
  folderStats: null,
  loading: false,
  loadedOnce: false,
  error: '',
};

function dashboardReducer(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case 'FETCH_START':
      return { ...state, loading: true, error: '' };
    case 'FETCH_SUCCESS':
      return {
        ...state,
        loading: false,
        loadedOnce: true,
        stats: action.payload.stats,
        photos: action.payload.photos,
        people: action.payload.people,
        scanStatus: action.payload.scanStatus,
        clusters: action.payload.clusters,
        folderStats: action.payload.folderStats,
      };
    case 'FETCH_ERROR':
      return { ...state, loading: false, loadedOnce: true, error: action.payload };
    case 'RESET':
      return {
        ...initialState,
        loadedOnce: action.payload.loadedOnce,
      };
    default:
      return state;
  }
}

export function useDashboardData(currentCatalog: string | null, refreshKey: number) {
  const [state, dispatch] = useReducer(dashboardReducer, initialState);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (!currentCatalog) {
      dispatch({ type: 'RESET', payload: { loadedOnce: true } });
      return () => { if (abortRef.current === controller) abortRef.current = null; };
    }

    dispatch({ type: 'FETCH_START' });

    // Crie promises individuais com tratamento adequado de aborto
    const getStatsPromise = api.getStats(currentCatalog, controller.signal);
    const getPhotosPromise = api.getPhotosPage(currentCatalog, 100, 0, null, controller.signal);
    const getPeoplePromise = api.getPeople(false, currentCatalog, controller.signal);
    
    const getScanStatusPromise = api.getScanStatus(controller.signal).catch((err) => {
      if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
      return null;
    });
    const getClustersPromise = api.getReviewClusters(currentCatalog, 50, 0, controller.signal).catch((err) => {
      if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
      return null;
    });
    const getFolderStatsPromise = api.getFolderStats(currentCatalog, controller.signal).catch((err) => {
      if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
      return null;
    });

    Promise.all([
      getStatsPromise,
      getPhotosPromise,
      getPeoplePromise,
      getScanStatusPromise,
      getClustersPromise,
      getFolderStatsPromise,
    ])
      .then(([s, pp, pe, sc, cl, fs]) => {
        if (controller.signal.aborted) return;
        dispatch({
          type: 'FETCH_SUCCESS',
          payload: {
            stats: s as Stats,
            photos: (pp as { photos: Photo[] }).photos,
            people: pe as Person[],
            scanStatus: sc as ScanStatus | null,
            clusters: cl as ReviewClustersPageResponse | null,
            folderStats: fs as CatalogFolderStats | null,
          },
        });
      })
      .catch((err: unknown) => {
        const errorObj = err as Error | null;
        if (errorObj?.name === 'AbortError' || controller.signal.aborted) {
          return;
        }
        console.error('[useDashboardData] erro:', errorObj);
        dispatch({ type: 'FETCH_ERROR', payload: 'Não foi possível carregar a visão geral.' });
      });

    return () => { controller.abort(); };
  }, [currentCatalog, refreshKey]);

  const data = useMemo(() => {
    return state.stats !== null || state.people.length > 0
      ? computeDashboardMetrics(state.people, state.photos, state.stats, state.clusters, state.scanStatus)
      : null;
  }, [state.people, state.photos, state.stats, state.clusters, state.scanStatus]);

  return {
    data,
    photos: state.photos,
    people: state.people,
    stats: state.stats,
    scanStatus: state.scanStatus,
    clusters: state.clusters,
    folderStats: state.folderStats,
    loading: state.loading,
    loadedOnce: state.loadedOnce,
    error: state.error,
  };
}
