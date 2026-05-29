import { useCallback, useImperativeHandle, forwardRef, useState, useMemo } from 'react';
import { Check, X, Sparkles, Settings2, ChevronUp } from 'lucide-react';
import type { RichCluster } from '../../services/api';
import { api } from '../../services/api';
import { CONF_CONFIRMED, CONF_POSSIBLE } from '../../utils/constants';
import styles from './GraduationActions.module.css';

export type GraduationItem = 'gown' | 'diploma' | 'sash' | 'cap' | 'jabor';

const ITEMS: GraduationItem[] = ['gown', 'diploma', 'sash', 'cap', 'jabor'];

const ITEM_TAG: Record<GraduationItem, string> = {
  gown: 'beca',
  diploma: 'canudo',
  sash: 'faixa',
  cap: 'capelo',
  jabor: 'jabor',
};

const ITEM_LABEL: Record<GraduationItem, string> = {
  gown: 'Beca',
  diploma: 'Canudo',
  sash: 'Faixa',
  cap: 'Capelo',
  jabor: 'Jabor',
};

const ITEM_CONFIDENCE_KEY: Record<GraduationItem, keyof RichCluster> = {
  gown: 'gown_confidence',
  diploma: 'diploma_confidence',
  sash: 'sash_confidence',
  cap: 'cap_confidence',
  jabor: 'jabor_confidence',
};

const ITEM_HAS_KEY: Record<GraduationItem, keyof RichCluster> = {
  gown: 'has_gown',
  diploma: 'has_diploma',
  sash: 'has_sash',
  cap: 'has_cap',
  jabor: 'has_jabor',
};

type ItemState = 'manual_confirm' | 'manual_remove' | 'ai_confirmed' | 'ai_possible' | 'none';

function getItemState(cluster: RichCluster, item: GraduationItem): ItemState {
  const tag = ITEM_TAG[item];
  const manualTags = cluster.manual_graduation_tags ?? [];
  if (manualTags.includes(tag)) return 'manual_confirm';
  if (manualTags.includes(`!${tag}`)) return 'manual_remove';

  // Tenta confidence primeiro
  const conf = (cluster[ITEM_CONFIDENCE_KEY[item]] as number | undefined)
    ?? ((cluster[ITEM_HAS_KEY[item]] as boolean | undefined) ? 1 : undefined);

  if (conf !== undefined) {
    if (conf >= CONF_CONFIRMED) return 'ai_confirmed';
    if (conf >= CONF_POSSIBLE) return 'ai_possible';
    return 'none';
  }

  // Fallback: verifica graduation_tags e ai_graduation_tags (vindos do backend sem confidence)
  const allTags = [
    ...(cluster.graduation_tags ?? []),
    ...(cluster.ai_graduation_tags ?? []),
  ].map(t => t.toLowerCase());

  if (allTags.includes(tag.toLowerCase())) return 'ai_confirmed';
  return 'none';
}


function applyOverrideLocally(cluster: RichCluster, item: GraduationItem, action: 'confirm' | 'remove'): RichCluster {
  const tag = ITEM_TAG[item];
  const negTag = `!${tag}`;
  const next = [...(cluster.manual_graduation_tags ?? [])].filter(t => t !== tag && t !== negTag);
  next.push(action === 'confirm' ? tag : negTag);
  const confKey = ITEM_CONFIDENCE_KEY[item];
  const hasKey = ITEM_HAS_KEY[item];
  return {
    ...cluster,
    manual_graduation_tags: next,
    [confKey]: action === 'confirm' ? 1.0 : 0.0,
    [hasKey]: action === 'confirm',
  } as RichCluster;
}

interface GraduationActionsProps {
  cluster: RichCluster;
  catalog?: string;
  onUpdate: (next: RichCluster) => void;
  onOverride?: (item: GraduationItem, action: 'confirm' | 'remove') => Promise<void>;
}

export interface GraduationActionsHandle {
  toggle: (item: GraduationItem) => void;
}

export const GraduationActions = forwardRef<GraduationActionsHandle, GraduationActionsProps>(
  function GraduationActions({ cluster, catalog, onUpdate, onOverride }, ref) {
    const [open, setOpen] = useState(false);
    const rowids = cluster.faces.map(f => f.rowid);

    const runOverride = useCallback(
      async (item: GraduationItem, action: 'confirm' | 'remove') => {
        const previous = cluster;
        const optimistic = applyOverrideLocally(cluster, item, action);
        onUpdate(optimistic);
        try {
          if (onOverride) {
            await onOverride(item, action);
          } else if (catalog) {
            await api.graduationManualOverride(catalog, { rowids, action, item });
          }
        } catch (err) {
          console.error('[graduationManualOverride] erro:', err);
          onUpdate(previous);
        }
      },
      [cluster, catalog, rowids, onUpdate, onOverride]
    );

    const toggle = useCallback(
      (item: GraduationItem) => {
        const state = getItemState(cluster, item);
        const isCurrentlyShown = state === 'manual_confirm' || state === 'ai_confirmed' || state === 'ai_possible';
        runOverride(item, isCurrentlyShown ? 'remove' : 'confirm');
      },
      [cluster, runOverride]
    );

    useImperativeHandle(ref, () => ({ toggle }), [toggle]);

    const summary = useMemo(
      () => ITEMS.map(item => ({ item, state: getItemState(cluster, item) })),
      [cluster]
    );
    const visible = useMemo(
      () => summary.filter(({ state }) => state !== 'none' && state !== 'manual_remove'),
      [summary]
    );
    const hasManual = useMemo(
      () => summary.some(({ state }) => state === 'manual_confirm' || state === 'manual_remove'),
      [summary]
    );

    return (
      <div className={styles.root}>
        <div className={styles.bar}>
          <div className={styles.summary}>
            {visible.length === 0 ? (
              <span className={styles.empty}>Nenhum item detectado</span>
            ) : (
              visible.map(({ item, state }) => (
                <span
                  key={item}
                  className={`${styles.chip} ${
                    state === 'manual_confirm' ? styles.chipManual :
                    state === 'ai_confirmed' ? styles.chipConfirmed :
                    styles.chipPossible
                  }`}
                >
                  {ITEM_LABEL[item]}
                </span>
              ))
            )}
            {hasManual && (
              <span className={styles.manualBadge}>
                <Sparkles size={9} />
                <span>Manual</span>
              </span>
            )}
          </div>
          <button
            type="button"
            className={`${styles.btnToggle} ${open ? styles.btnToggleOpen : ''}`}
            onClick={() => setOpen(v => !v)}
            title={open ? 'Fechar correção' : 'Corrigir itens'}
          >
            {open ? <ChevronUp size={13} /> : <Settings2 size={13} />}
            <span>{open ? 'Fechar' : 'Corrigir itens'}</span>
          </button>
        </div>

        {open && (
          <div className={styles.panel}>
            {ITEMS.map(item => {
              const state = getItemState(cluster, item);
              const isConfirmed = state === 'manual_confirm' || state === 'ai_confirmed' || state === 'ai_possible';
              const isRemoved = state === 'manual_remove';
              const isManual = state === 'manual_confirm' || state === 'manual_remove';
              return (
                <div key={item} className={styles.row}>
                  <span className={styles.itemLabel}>{ITEM_LABEL[item]}</span>
                  <div className={styles.btnGroup}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnConfirm} ${isConfirmed ? styles.active : ''}`}
                      onClick={() => runOverride(item, 'confirm')}
                      title={`Confirmar ${ITEM_LABEL[item].toLowerCase()}`}
                    >
                      <Check size={11} />
                      <span>Confirmar</span>
                    </button>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnRemove} ${isRemoved ? styles.active : ''}`}
                      onClick={() => runOverride(item, 'remove')}
                      title={`Remover ${ITEM_LABEL[item].toLowerCase()}`}
                    >
                      <X size={11} />
                      <span>Remover</span>
                    </button>
                  </div>
                  <span className={`${styles.rowManualTag} ${isManual ? styles.rowManualTagVisible : ''}`}>
                    Manual
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }
);
