import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from './icons';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Lightweight error boundary for individual page routes.
 * Isolates page-level crashes so the rest of the app (sidebar, nav) stays functional.
 */
export class PageErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Page error:', error, errorInfo);
  }

  handleRetry = () => {
    const message = this.state.error?.message ?? '';
    if (/dynamically imported module|Unable to preload CSS|ChunkLoadError|Loading chunk/i.test(message)) {
      window.location.reload();
      return;
    }
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-8">
          <div className="w-12 h-12 mb-4 rounded-full bg-error/10 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-error" />
          </div>
          <h2 className="text-lg font-medium text-text-primary dark:text-dark-text-primary mb-2">
            Não foi possível carregar esta seção
          </h2>
          <p className="text-sm text-text-muted dark:text-dark-text-muted mb-1 max-w-sm text-center">
            O Astra encontrou um erro nesta área. Tente novamente.
          </p>
          {this.state.error && (
            <p className="text-xs font-mono text-error mb-4 max-w-sm text-center truncate">
              {this.state.error.message}
            </p>
          )}
          <button
            onClick={this.handleRetry}
            className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg transition-colors text-sm"
          >
            <RefreshCw className="w-4 h-4" />
            Tentar novamente
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
