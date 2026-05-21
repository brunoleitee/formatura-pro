import type { CloudCatalogMode as CloudCatalogModeValue } from './types';
import styles from './CloudWorkflowPanel.module.css';

type CloudCatalogModeProps = {
  value: CloudCatalogModeValue;
  onChange: (mode: CloudCatalogModeValue) => void;
  disabled?: boolean;
};

const modes: { value: CloudCatalogModeValue; label: string; description: string }[] = [
  { value: 'catalog', label: 'Somente catálogo', description: 'Indexação e organização visual.' },
  { value: 'face', label: 'Reconhecimento facial', description: 'Prepara o evento para IA de rostos.' },
  { value: 'full', label: 'Scanner completo', description: 'Estrutura pronta para fluxo completo.' },
];

export function CloudCatalogMode({ value, onChange, disabled = false }: CloudCatalogModeProps) {
  return (
    <div className={styles.modeGroup}>
      {modes.map(mode => (
        <label className={styles.modeOption} key={mode.value} data-selected={value === mode.value}>
          <input
            type="radio"
            name="cloudCatalogMode"
            checked={value === mode.value}
            onChange={() => onChange(mode.value)}
            disabled={disabled}
          />
          <span>
            <strong>{mode.label}</strong>
            <small>{mode.description}</small>
          </span>
        </label>
      ))}
    </div>
  );
}
