import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { useAuth } from '../hooks/useAuth';
import { ShieldCheck } from '../components/icons';

export function LoginPage() {
  const { isAuthenticated, passwordConfigured, isLoading, login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isLoading && (isAuthenticated || !passwordConfigured)) {
    return <Navigate to="/" replace />;
  }

  if (isLoading) {
    return (
      <div className="astra-login-screen flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      await login(password);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Não foi possível entrar. Verifique sua senha.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="astra-login-screen flex min-h-screen items-center justify-center px-4 py-8">
      <div className="astra-login-card w-full max-w-[410px] p-7 sm:p-9">
        <div className="astra-login-symbol mb-6" aria-hidden="true">
          A
        </div>
        <p className="astra-login-eyebrow">BEM-VINDO DE VOLTA</p>
        <h1 className="mb-2 text-3xl font-bold tracking-tight text-text-primary dark:text-dark-text-primary">
          Acesse seu Astra
        </h1>
        <p className="mb-7 text-sm leading-6 text-text-secondary dark:text-dark-text-secondary">
          Seu assistente pessoal, agenda e finanças em um só lugar.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="astra-login-password"
              className="mb-2 block text-sm font-medium text-text-primary dark:text-dark-text-primary"
            >
              Senha de acesso
            </label>
            <input
              id="astra-login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Digite sua senha"
              autoFocus
              autoComplete="current-password"
              required
              className="w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-dark-border dark:bg-dark-bg-primary dark:text-dark-text-primary"
            />
          </div>
          {error && (
            <p className="text-sm text-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={!password || isSubmitting}
            className="astra-login-submit w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? 'Entrando...' : 'Entrar no painel'}
          </button>
        </form>
        <div className="mt-8 flex items-center gap-2 border-t border-border pt-5 text-xs text-text-muted dark:border-dark-border dark:text-dark-text-muted">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          <span>Conexão protegida e seus dados em ambiente privado.</span>
        </div>
      </div>
    </div>
  );
}
