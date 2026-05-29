import { useState, useEffect, useCallback, useRef, memo, useMemo } from 'react';
import { PhotoGridContext, usePhotoGridContext } from '../hooks/usePhotoGridContext';
import { ArrowLeft, RefreshCw, Image as ImageIcon } from 'lucide-react';
import { api, type Photo } from '../services/api';
import { useApp } from '../context/AppContext';
import { MemoPhotoCard } from '../components/photos/PhotoCard';
import { PhotoDetailPanel } from '../components/photos/PhotoDetailPanel';
import { PhotoViewerModal } from '../components/photos/PhotoViewerModal';
import { usePhotoSelection, getPhotoId } from '../hooks/usePhotoSelection';
import { usePhotoViewer } from '../hooks/usePhotoViewer';
import PhotoBulkActionsBar from '../components/photos/PhotoBulkActionsBar';

const PERSON_THUMB_SIZE = 240;
const PERSON_OBSERVER_MARGIN = '300px';

function ObserverPhotoCard({ photo, isSelected }: {
  photo: Photo;
  isSelected: boolean;
}) {
  const ctx = usePhotoGridContext();
  const [visible, setVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: PERSON_OBSERVER_MARGIN, threshold: 0 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [photo.path]);

  return (
    <div ref={cardRef}>
      <MemoPhotoCard
        photo={photo}
        isSelected={isSelected}
        onClick={ctx.onPhotoClick}
        onDoubleClick={ctx.onDoubleClick}
        onOpenDetails={ctx.onOpenDetails}
        onDragStart={ctx.onDragStart}
        onDragEnd={ctx.onDragEnd}
        getSelectionCount={ctx.getSelectionCount}
        thumbTargetSize={visible ? PERSON_THUMB_SIZE : 0}
      />
    </div>
  );
}

const MemoObserverPhotoCard = memo(ObserverPhotoCard);

function Section({ 
  title, 
  items, 
  color,
}: { 
  title: string; 
  items: Photo[]; 
  color: string;
}) {
  const ctx = usePhotoGridContext();
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 32 }}>
      <h3 style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
        {title}
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 400 }}>({items.length})</span>
      </h3>
      <div className="photo-grid">
        {items.map((p) => {
          const id = getPhotoId(p);
          return (
            <MemoObserverPhotoCard
              key={id}
              photo={p}
              isSelected={ctx.selectedPaths.has(id)}
            />
          );
        })}
      </div>
    </div>
  );
}

export default function PersonDetailView() {
  const { selectedPersonId, navigate, currentCatalog } = useApp();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailsPhoto, setDetailsPhoto] = useState<Photo | null>(null);
  const [personInfo, setPersonInfo] = useState<{ name: string; class_name: string; person_key?: string } | null>(null);
  const [planeFilter, setPlaneFilter] = useState<'all' | 'foreground' | 'background'>('all');
  const [sortBy, setSortBy] = useState<'name' | 'mtime_desc' | 'mtime_asc' | 'quality_desc'>('name');

  const { selectedPaths, toggleSelection, clearSelection } = usePhotoSelection(photos);
  const { viewerPhoto, setViewerPhoto } = usePhotoViewer(photos);
  const [bulkBarVisible, setBulkBarVisible] = useState(false);
  const [, setIsDraggingPhoto] = useState(false);
  const selectionCountRef = useRef(0);
  const getSelectionCount = useCallback(() => selectionCountRef.current, []);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollPos = useRef(0);
  const lastScrollTime = useRef(0);
  const personDiscardKey = personInfo?.person_key || (selectedPersonId?.includes('::') ? selectedPersonId : selectedPersonId || '');

  const getLocalFaceRowIds = useCallback((photo: Photo) => {
    const scopeKey = personDiscardKey.trim();
    const rowIds = (photo.faces || [])
      .filter(face => {
        const faceKey = (face.person_key || '').trim();
        const faceAluno = (face.aluno_id || '').trim();
        return !scopeKey || faceKey === scopeKey || faceAluno === selectedPersonId;
      })
      .map(face => face.rowid)
      .filter((rowid): rowid is number => typeof rowid === 'number' && Number.isFinite(rowid));
    return rowIds;
  }, [personDiscardKey, selectedPersonId]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const now = Date.now();
    const delta = Math.abs(el.scrollTop - lastScrollPos.current);
    const dt = now - lastScrollTime.current;
    lastScrollPos.current = el.scrollTop;
    lastScrollTime.current = now;
    const speed = dt > 0 ? delta / dt : 0;
    if (speed > 1.5) {
      el.setAttribute('data-scrolling', 'fast');
    }
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      el.removeAttribute('data-scrolling');
    }, 500);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, [handleScroll]);

  useEffect(() => {
    selectionCountRef.current = selectedPaths.size;
  }, [selectedPaths.size]);

  const loadAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    // Cancelar request anterior se existir
    if (loadAbortRef.current) {
      loadAbortRef.current.abort();
    }
    const controller = new AbortController();
    loadAbortRef.current = controller;

    if (!selectedPersonId || !currentCatalog) return;
    setLoading(true);
    try {
      const personIdParam = selectedPersonId.includes('::') ? selectedPersonId : selectedPersonId;
      const [data, people] = await Promise.all([
        api.getPersonPhotos(personIdParam, currentCatalog, controller.signal),
        api.getPeople(false, currentCatalog, controller.signal).catch(() => []),
      ]);
      if (controller.signal.aborted) return;
      setPhotos(data);

      const matched = (people as Array<{ id?: string; name?: string; class_name?: string; person_key?: string }>).find(
        (person) => (person.person_key && person.person_key === selectedPersonId) ||
                     person.id === selectedPersonId ||
                     person.name === selectedPersonId
      );
      setPersonInfo(matched ? {
        name: matched.name || selectedPersonId,
        class_name: (matched.class_name || 'Sem turma').trim() || 'Sem turma',
        person_key: matched.person_key || (selectedPersonId.includes('::') ? selectedPersonId : undefined),
      } : {
        name: selectedPersonId.includes('::') ? selectedPersonId.split('::').pop() || selectedPersonId : selectedPersonId,
        class_name: selectedPersonId.includes('::') ? selectedPersonId.split('::')[1] || 'Sem turma' : 'Sem turma',
        person_key: selectedPersonId.includes('::') ? selectedPersonId : undefined,
      });
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        console.error(e);
        setError('Erro ao carregar fotos do formando.');
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [selectedPersonId, currentCatalog]);

  useEffect(() => {
    load();
    return () => {
      if (loadAbortRef.current) {
        loadAbortRef.current.abort();
      }
    };
  }, [load]);

  const updatePhotoStatusLocal = useCallback((path: string, updates: Partial<Photo>) => {
    setPhotos(prev => prev.map(p => 
      p.path === path ? { ...p, ...updates } : p
    ));
  }, []);

  const handleDiscardSelected = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    const paths = photos.filter(p => selectedPaths.has(getPhotoId(p))).map(p => p.path);
    paths.forEach(p => updatePhotoStatusLocal(p, {
      discarded: true,
      discarded_scope: 'person',
      discarded_global: false,
      discarded_local: true,
    }));
    const rowids = photos
      .filter(p => selectedPaths.has(getPhotoId(p)))
      .flatMap(p => getLocalFaceRowIds(p));
    clearSelection();
    try {
      await api.bulkDiscardPhotos(currentCatalog, paths, { scope: 'person', person_key: personDiscardKey, rowids });
      load();
    } catch (e) { 
      console.error(e);
      setError('Erro ao descartar fotos.');
      load();
    }
  }, [selectedPaths, photos, currentCatalog, clearSelection, updatePhotoStatusLocal, load, personDiscardKey, getLocalFaceRowIds]);

  const handleRestoreSelected = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    const paths = photos.filter(p => selectedPaths.has(getPhotoId(p))).map(p => p.path);
    paths.forEach(p => updatePhotoStatusLocal(p, {
      discarded: false,
      discarded_scope: null,
      discarded_global: false,
      discarded_local: false,
    }));
    const rowids = photos
      .filter(p => selectedPaths.has(getPhotoId(p)))
      .flatMap(p => getLocalFaceRowIds(p));
    clearSelection();
    try {
      await api.bulkRestorePhotos(currentCatalog, paths, { scope: 'person', person_key: personDiscardKey, rowids });
      load();
    } catch (e) { 
      console.error(e);
      setError('Erro ao restaurar fotos.');
      load();
    }
  }, [selectedPaths, photos, currentCatalog, clearSelection, updatePhotoStatusLocal, load, personDiscardKey, getLocalFaceRowIds]);

  const handleRemoveIdentificationSelected = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    try {
      const selectedPhotos = photos.filter(p => selectedPaths.has(getPhotoId(p)));
      const rowids: number[] = [];
      selectedPhotos.forEach(p => {
        (p.faces || []).forEach(f => {
          if (f.rowid) rowids.push(f.rowid);
        });
      });
      
      if (rowids.length > 0) {
        await api.bulkManualIdentify(currentCatalog, "Desconhecido", rowids);
        clearSelection();
        load();
      }
    } catch (e) { console.error(e); setError('Erro ao remover identificação.'); }
  }, [selectedPaths, photos, currentCatalog, clearSelection, load]);

  const handleDragStart = useCallback((photo: Photo) => {
    const id = getPhotoId(photo);
    if (!selectedPaths.has(id)) {
      toggleSelection(photo, { ctrlKey: false, metaKey: false, shiftKey: false } as any);
    }
    setIsDraggingPhoto(true);
    setBulkBarVisible(true);
  }, [selectedPaths, toggleSelection]);

  const handleDragEnd = useCallback((_photo: Photo, e: React.PointerEvent) => {
    setIsDraggingPhoto(false);
    
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const actionBtn = target?.closest('[data-bulk-action]');
    
    if (actionBtn) {
      const action = actionBtn.getAttribute('data-bulk-action');
      if (action === 'discard') handleDiscardSelected();
      else if (action === 'restore') handleRestoreSelected();
      else if (action === 'remove-identification') handleRemoveIdentificationSelected();
    }
  }, [handleDiscardSelected, handleRestoreSelected, handleRemoveIdentificationSelected]);

  // Reset bulk bar if selection is cleared
  useEffect(() => {
    if (selectedPaths.size === 0) {
      setBulkBarVisible(false);
    }
  }, [selectedPaths.size]);

  // Hide bulk bar when opening viewer
  useEffect(() => {
    if (viewerPhoto) {
      setBulkBarVisible(false);
    }
  }, [viewerPhoto]);

  if (!selectedPersonId) return null;

  const getFilteredAndSortedPhotos = (items: Photo[]) => {
    let filtered = [...items];
    if (planeFilter !== 'all') {
      filtered = filtered.filter(photo => {
        const face = (photo.faces || []).find(
          f => (f.person_key && f.person_key === selectedPersonId) ||
               f.aluno_id === selectedPersonId
        );
        if (!face) return false;
        const isFg = face.is_foreground === 1 || (face.foreground_score != null && face.foreground_score >= 0.65);
        if (planeFilter === 'foreground') return isFg;
        
        const isBg = face.is_foreground === 0 || (face.foreground_score !== undefined && face.foreground_score !== null && face.foreground_score < 0.45);
        return isBg;
      });
    }

    filtered.sort((a, b) => {
      if (sortBy === 'name') {
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      }
      if (sortBy === 'mtime_desc') {
        return (b.mtime || 0) - (a.mtime || 0);
      }
      if (sortBy === 'mtime_asc') {
        return (a.mtime || 0) - (b.mtime || 0);
      }
      if (sortBy === 'quality_desc') {
        return (b.blur_score || 0) - (a.blur_score || 0);
      }
      return 0;
    });

    return filtered;
  };

  const good = photos.filter(p => !p.discarded && p.blur_label !== 'blurry');
  const attention = photos.filter(p => !p.discarded && p.blur_label === 'attention');
  const blurry = photos.filter(p => !p.discarded && p.blur_label === 'blurry');
  const discarded = photos.filter(p => p.discarded);

  const filteredGood = getFilteredAndSortedPhotos(good.filter(p => p.blur_label !== 'attention'));
  const filteredAttention = getFilteredAndSortedPhotos(attention);
  const filteredBlurry = getFilteredAndSortedPhotos(blurry);
  const filteredDiscarded = getFilteredAndSortedPhotos(discarded);

  const photoGridCtx = useMemo(() => ({
    selectedPaths, containerRef: scrollRef,
    onPhotoClick: toggleSelection, onDoubleClick: setViewerPhoto,
    onOpenDetails: setDetailsPhoto, onDragStart: handleDragStart,
    onDragEnd: handleDragEnd, getSelectionCount,
  }), [selectedPaths, scrollRef, toggleSelection, setViewerPhoto, setDetailsPhoto, handleDragStart, handleDragEnd, getSelectionCount]);

  return (
    <div className="view-container" style={{ position: 'relative' }}>
      <div className="view-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="icon-btn" onClick={() => navigate('people')}>
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1>{personInfo?.name || selectedPersonId}</h1>
            <p className="view-subtitle">
              {personInfo?.class_name && personInfo.class_name !== 'Sem turma' ? (
                <><strong>{personInfo.class_name}</strong> · </>
              ) : null}
              {photos.length} foto{photos.length !== 1 ? 's' : ''} no total
            </p>
          </div>
        </div>
        <div className="view-header-actions">
          <button className="icon-btn" onClick={load}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {!loading && photos.length > 0 && (
        <div 
          style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'space-between',
            gap: '16px',
            padding: '8px 0 16px 0',
            borderBottom: '1px solid var(--border-default)',
            marginBottom: '20px',
            flexWrap: 'wrap'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Plano do Formando:</span>
            <div className="tab-group">
              <button 
                className={`tab-btn ${planeFilter === 'all' ? 'active' : ''}`}
                onClick={() => setPlaneFilter('all')}
                style={{ fontSize: '0.75rem', height: '28px', padding: '0 12px' }}
              >
                Todos
              </button>
              <button 
                className={`tab-btn ${planeFilter === 'foreground' ? 'active' : ''}`}
                onClick={() => setPlaneFilter('foreground')}
                style={{ fontSize: '0.75rem', height: '28px', padding: '0 12px' }}
              >
                1º Plano (Destaque)
              </button>
              <button 
                className={`tab-btn ${planeFilter === 'background' ? 'active' : ''}`}
                onClick={() => setPlaneFilter('background')}
                style={{ fontSize: '0.75rem', height: '28px', padding: '0 12px' }}
              >
                2º Plano (Fundo)
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Ordenar por:</span>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <select
                className="select-base"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                style={{ 
                  height: '28px', 
                  fontSize: '0.75rem', 
                  padding: '0 28px 0 10px',
                  background: 'var(--bg-tertiary)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  outline: 'none'
                }}
              >
                <option value="name">Nome do arquivo (A-Z)</option>
                <option value="mtime_desc">Mais recentes primeiro</option>
                <option value="mtime_asc">Mais antigas primeiro</option>
                <option value="quality_desc">Melhor qualidade/foco</option>
              </select>
              <span 
                style={{ 
                  position: 'absolute', 
                  right: '8px', 
                  color: 'var(--text-secondary)', 
                  pointerEvents: 'none', 
                  display: 'flex', 
                  alignItems: 'center',
                  fontSize: '0.65rem'
                }}
              >
                ▼
              </span>
            </div>
          </div>
        </div>
      )}

      {loading && photos.length === 0 ? (
        <div className="empty-state">
          <RefreshCw size={32} className="spin" />
          <p>Carregando fotos...</p>
        </div>
      ) : photos.length === 0 ? (
        <div className="empty-state">
          <ImageIcon size={48} opacity={0.3} />
          <h3>Nenhuma foto encontrada</h3>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 24, flex: 1, overflow: 'hidden' }}>
          <div
            ref={scrollRef}
            data-scroll-container="true"
            style={{ flex: 1, overflowY: 'auto', paddingRight: 8 }}
          >
            <PhotoGridContext.Provider value={photoGridCtx}>
              <Section title="Boas fotos" items={filteredGood} color="var(--success-color)" />
              <Section title="Requer atenção" items={filteredAttention} color="var(--warning-color)" />
              <Section title="Desfocadas" items={filteredBlurry} color="var(--danger-color)" />
              <Section title="Descartadas" items={filteredDiscarded} color="var(--text-secondary)" />
            </PhotoGridContext.Provider>
          </div>

          {detailsPhoto && (
            <PhotoDetailPanel
              photo={detailsPhoto}
              onClose={() => setDetailsPhoto(null)}
            />
          )}
        </div>
      )}

      {viewerPhoto && (
        <PhotoViewerModal
          photo={viewerPhoto}
          allPhotos={photos}
          onClose={() => setViewerPhoto(null)}
          onNavigate={setViewerPhoto}
          discardScope="person"
          discardPersonKey={personDiscardKey}
          discardFaceRowIds={getLocalFaceRowIds(viewerPhoto)}
          onDiscard={(path) => updatePhotoStatusLocal(path, {
            discarded: true,
            discarded_scope: 'person',
            discarded_global: false,
            discarded_local: true,
          })}
          onRestore={(path) => updatePhotoStatusLocal(path, {
            discarded: false,
            discarded_scope: null,
            discarded_global: false,
            discarded_local: false,
          })}
        />
      )}

      {selectedPaths.size > 0 && bulkBarVisible && !viewerPhoto && (
        <PhotoBulkActionsBar
          selectedCount={selectedPaths.size}
          onDiscard={handleDiscardSelected}
          onRestore={handleRestoreSelected}
          onRemoveIdentification={handleRemoveIdentificationSelected}
          onClearSelection={clearSelection}
        />
      )}
    </div>
  );
}
