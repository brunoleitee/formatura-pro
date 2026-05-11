import { useCallback, useImperativeHandle, forwardRef } from 'react';
import { Check, X, Sparkles } from 'lucide-react';
import type { RichCluster } from '../../services/api';
import { api } from '../../services/api';
import styles from './GraduationActions.module.css';

export type GraduationItem = 'gown' | 'diploma' | 'sash' | 'cap';

const ITEM_TAG: Record<GraduationItem, string> = {
  gown: 'beca',
  diploma: 'canudo',
  sash: 'faixa',
  cap: 'capelo',
};

const ITEM_LABEL: Record<GraduationItem, string> = {
  gown: 'Beca',
  diploma: 'Canudo',
  sash: 'Faixa',
  cap: 'Capelo',
};

const ITEM_CONFIDENCE_KEY: Record<GraduationItem, keyof RichCluster> = {
  gown: 'gown_confidence',
  diploma: 'diploma_confidence',
  sash: 'sash_confidence',
  cap: 'cap_confidence',
};

const ITEM_HAS_KEY: Record<GraduationItem, keyof RichCluster> = {
  gown: 'has_gown',
  diploma: 'has_diploma',
  sash: 'has_sash',
  cap: 'has_cap',
};

const CONF_CONFIRMED = 0.92;
const CONF_POSSIBLE = 0.70;

type ItemState = 'manual_confirm' | 'manual_remove' | 'ai_confirmed' | 'ai_possible' | 'none';

function getItemState(cluster: RichCluster, item: GraduationItem): ItemState {
  const tag = ITEM_TAG[item];
  const manualTags = cluster.manual_graduation_tags ?? [];
  if (manualTags.includes(tag)) return 'manual_confirm';
  if (manualTags.includes(`!${tag}`)) return 'manual_remove';
  const conf = (cluster[ITEM_CONFIDENCE_KEY[item]] as number | undefined)
    ?? ((cluster[ITEM_HAS_KEY[item]] as boolean | undefined) ? 1 : 0);
  if (conf >= CONF_CONFIRMED) return 'ai_confirmed';
  if (conf >= CONF_POSSIBLE) return 'ai_possible';
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
  catalog: string;
  onUpdate: (next: RichCluster) => void;
}

export interface GraduationActionsHandle {
  toggle: (item: GraduationItem) => void;
}

export const GraduationActions = forwardRef<GraduationActionsHandle, GraduationActionsProps>(
  function GraduationActions({ cluster, catalog, onUpdate }, ref) {
    const rowids = cluster.faces.map(f => f.rowid);

    const runOverride = useCallback(
      async (item: GraduationItem, action: 'confirm' | 'remove') => {
        const previous = cluster;
        const optimistic = applyOverrideLocally(cluster, item, action);
        onUpdate(optimistic);
        try {
          await api.graduationManualOverride(catalog, { rowids, action, item });
        } catch (err) {
          console.error('[graduationManualOverride] erro:', err);
          onUpdate(previous);
        }
      },
      [cluster, catalog, rowids, onUpdate]
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

    return (
      <div className={styles.root}>
        {(['gown', 'diploma', 'sash', 'cap'] as const).map((item) => {
          const state = getItemState(cluster, item);
          const isManual = state === 'manual_confirm' || state === 'manual_remove';
          const isConfirmed = state === 'manual_confirm' || state === 'ai_confirmed' || state === 'ai_possible';
          const isRemoved = state === 'manual_remove';
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
                  <Check size={12} />
                  <span>Confirmar</span>
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnRemove} ${isRemoved ? styles.active : ''}`}
                  onClick={() => runOverride(item, 'remove')}
                  title={`Remover ${ITEM_LABEL[item].toLowerCase()}`}
                >
                  <X size={12} />
                  <span>Remover</span>
                </button>
              </div>
              <span className={`${styles.manualBadge} ${isManual ? styles.visible : ''}`}>
                <Sparkles size={9} />
                <span>Manual</span>
              </span>
            </div>
          );
        })}
      </div>
    );
  }
);
