import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minHeight: '100vh', padding: 40, textAlign: 'center', background: 'var(--background)',
          color: 'var(--foreground)', gap: 16,
        }}>
          <AlertTriangle size={48} style={{ color: 'var(--danger)' }} />
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Algo deu errado</h1>
          <p style={{ color: 'var(--text-secondary)', maxWidth: 400, lineHeight: 1.5 }}>
            Ocorreu um erro inesperado. Tente recarregar a página.
          </p>
          {this.state.error && (
            <pre style={{
              fontSize: '0.75rem', color: 'var(--text-muted)', background: 'var(--muted)',
              padding: '8px 12px', borderRadius: 8, maxWidth: '100%', overflow: 'auto',
            }}>
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={() => window.location.reload()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 24px',
              background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8,
              cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem',
            }}
          >
            <RefreshCw size={16} />
            Recarregar página
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
