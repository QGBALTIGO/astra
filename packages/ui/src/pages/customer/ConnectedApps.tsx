import { useRef, useState } from 'react';
import { Calendar, ExternalLink, Globe } from '../../components/icons';
import { CustomerConfirm, CustomerError, CustomerSkeleton } from './components';
import { customerApi } from './api';
import { useCustomerQuery } from './hooks';
import type { CustomerAppSlug } from './types';

/** Per-account OAuth controls. This does not imply automatic agent/sync access. */
export function CustomerConnectedApps({
  active,
  canWrite,
  onChanged,
}: {
  active: boolean;
  canWrite: boolean;
  onChanged: (message: string) => void;
}) {
  const apps = useCustomerQuery('customer-connected-apps', (signal) => customerApi.connectedApps(signal), active);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  const connect = async (app: CustomerAppSlug) => {
    if (lock.current || !canWrite || !apps.data?.configured) return;
    lock.current = true;
    setBusy(app);
    setError(null);
    try {
      const result = await customerApi.connectApp(app);
      const link = new URL(result.redirectUrl);
      if (
        link.protocol !== 'https:' ||
        !['composio.dev', 'composio.com'].some(
          (root) => link.hostname === root || link.hostname.endsWith('.' + root)
        )
      )
        throw new Error('Link de autorização inválido.');
      window.location.assign(link.toString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível conectar.');
      lock.current = false;
      setBusy(null);
    }
  };
  const disconnect = async (id: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy('disconnect');
    setError(null);
    try {
      await customerApi.disconnectApp(id);
      setConfirmId(null);
      apps.retry();
      onChanged('Aplicativo desconectado do seu Astra.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível desconectar.');
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  if (apps.loading && !apps.data) return <CustomerSkeleton />;
  if (apps.error)
    return <CustomerError error={apps.error} onRetry={apps.retry} />;

  return (
    <>
      {error ? <p className="ac-field-error" role="alert">{error}</p> : null}
      {!apps.data?.configured ? (
        <p className="ac-muted">
          Gmail e Google Agenda ainda estão em configuração. Cada pessoa poderá conectar sua
          própria conta quando a autorização segura estiver habilitada.
        </p>
      ) : null}
      {apps.data?.apps.map((app) => {
        const isConnected = app.status === 'connected';
        const isCalendar = app.slug === 'googlecalendar';
        const Icon = isCalendar ? Calendar : Globe;
        return (
          <div className="ac-integration" key={app.slug}>
            <Icon aria-hidden="true" />
            <div>
              <h3>{app.name}</h3>
              <span className="ac-status">
                {isConnected ? 'Conectado' : app.status === 'needs_attention'
                  ? 'Reconexão necessária' : app.status === 'unavailable'
                    ? 'Aguardando ativação' : 'Não conectado'}
              </span>
              <p>
                {isCalendar
                  ? 'Autorize sua conta Google para os recursos de agenda.'
                  : 'Autorize sua conta Gmail para os recursos de e-mail.'}
              </p>
              {isConnected && app.connectionId ? (
                <button
                  className="ac-text-button"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setConfirmId(app.connectionId)}
                >
                  Desconectar
                </button>
              ) : (
                <button
                  className="ac-button ac-button--secondary"
                  type="button"
                  disabled={!apps.data?.configured || !canWrite || busy !== null}
                  onClick={() => void connect(app.slug)}
                >
                  {busy === app.slug ? 'Conectando…' : 'Conectar conta'}
                  <ExternalLink aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        );
      })}
      {apps.data?.configured ? (
        <p className="ac-field-help">
          A conexão autoriza o vínculo da conta. A sincronização e as ações da IA
          serão habilitadas separadamente, após validação de permissões.
        </p>
      ) : null}
      {confirmId ? (
        <CustomerConfirm
          title="Desconectar aplicativo?"
          action="Desconectar"
          onClose={() => setConfirmId(null)}
          onConfirm={() => void disconnect(confirmId)}
          busy={busy === 'disconnect'}
          error={error}
        >
          O Astra deixará de utilizar essa conexão. Seus dados salvos no painel não serão apagados.
        </CustomerConfirm>
      ) : null}
    </>
  );
}
