import { useRef, useState } from 'react';
import {
  Calendar,
  ExternalLink,
  Globe,
  RefreshCw,
  Shield,
  MessageSquare,
  Mail,
  Folder,
  Table,
  ListChecks,
} from '../../components/icons';
import { CustomerConfirm, CustomerError, CustomerSkeleton } from './components';
import { customerApi } from './api';
import { useCustomerQuery } from './hooks';
import type { CustomerAppSlug } from './types';

/** The customer session owns every grant and every refresh. */
export function CustomerConnectedApps({
  active,
  canWrite,
  onChanged,
}: {
  active: boolean;
  canWrite: boolean;
  onChanged: (message: string) => void;
}) {
  const apps = useCustomerQuery(
    'customer-connected-apps',
    (signal) => customerApi.connectedApps(signal),
    active
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorApp, setErrorApp] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ app: string; text: string } | null>(null);
  const [telegram, setTelegram] = useState<{
    command: string;
    expiresAt: string;
    botUrl?: string | null;
  } | null>(null);
  const lock = useRef(false);

  const connect = async (app: CustomerAppSlug) => {
    if (lock.current || !canWrite || !apps.data?.configured) return;
    lock.current = true;
    setBusy(app);
    setError(null);
    setErrorApp(app);
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
  const sync = async (app: CustomerAppSlug) => {
    if (lock.current || !canWrite) return;
    lock.current = true;
    setBusy(app);
    setError(null);
    setErrorApp(app);
    setNotice(null);
    try {
      const result = await customerApi.syncApp(app);
      setNotice({
        app,
        text: result.updated
          ? result.cached
            ? 'Os dados já estão atualizados.'
            : 'Dados atualizados no seu Astra.'
          : 'A atualização está em andamento. Consulte novamente em instantes.',
      });
      apps.retry();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar agora.');
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  const linkTelegram = async () => {
    if (lock.current || !canWrite) return;
    lock.current = true;
    setBusy('telegram');
    setError(null);
    setErrorApp('telegram');
    try {
      setTelegram(await customerApi.telegramLink());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível preparar o vínculo.');
    } finally {
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
  if (apps.error) return <CustomerError error={apps.error} onRetry={apps.retry} />;

  return (
    <>
      <div className="ac-connections-intro">
        <Shield aria-hidden="true" />
        <div>
          <h3>Suas contas. Sua rotina.</h3>
          <p>
            Conecte o que você usa e peça ao Astra pelo WhatsApp ou Telegram. Cada cliente usa
            apenas as próprias contas.
          </p>
        </div>
      </div>
      {error && !errorApp ? (
        <p className="ac-field-error" role="alert">
          {error}
        </p>
      ) : null}
      {!apps.data?.configured ? (
        <p className="ac-muted">
          As conexões ainda estão em configuração. Você poderá autorizar suas contas de agenda,
          e-mail, documentos e tarefas assim que o serviço estiver pronto.
        </p>
      ) : null}
      <div className="ac-connections-grid">
        {apps.data?.apps.map((app) => {
          const isConnected = app.status === 'connected';
          const Icon =
            {
              googlecalendar: Calendar,
              gmail: Mail,
              googledrive: Folder,
              googlesheets: Table,
              todoist: ListChecks,
              notion: Table,
              trello: ListChecks,
            }[app.slug] ?? Globe;
          return (
            <article className="ac-connection-card" key={app.slug} aria-label={app.name}>
              <div className="ac-connection-heading">
                <span className="ac-connection-icon">
                  <Icon aria-hidden="true" />
                </span>
                <div>
                  <h3>{app.name}</h3>
                  <span className={'ac-connection-status' + (isConnected ? ' is-connected' : '')}>
                    {isConnected
                      ? 'Conectado'
                      : app.status === 'needs_attention'
                        ? 'Reconexão necessária'
                        : app.status === 'unavailable'
                          ? 'Aguardando ativação'
                          : app.status === 'pending'
                            ? 'Em autorização'
                            : 'Não conectado'}
                  </span>
                </div>
              </div>
              <p className="ac-connection-description">
                {app.description ?? 'Conecte sua conta para os recursos deste aplicativo.'}
              </p>
              {isConnected && (
                <div className="ac-connection-sync">
                  <RefreshCw aria-hidden="true" />
                  <span>
                    {app.lastSyncedAt
                      ? 'Atualizado em ' +
                        new Intl.DateTimeFormat('pt-BR', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                          ...(apps.data?.timeZone ? { timeZone: apps.data.timeZone } : {}),
                        }).format(new Date(app.lastSyncedAt))
                      : 'Pronto para a primeira consulta'}
                  </span>
                </div>
              )}
              {app.syncIssue && (
                <p className="ac-field-error" role="status">
                  {app.syncIssue}
                </p>
              )}
              {error && errorApp === app.slug && (
                <p className="ac-field-error" role="alert">
                  {error}
                </p>
              )}
              {notice?.app === app.slug && (
                <p className="ac-field-help" role="status">
                  {notice.text}
                </p>
              )}
              <div className="ac-connection-actions">
                {isConnected && app.connectionId ? (
                  <>
                    <button
                      className="ac-button ac-button--secondary"
                      type="button"
                      disabled={!canWrite || busy !== null}
                      onClick={() => void sync(app.slug)}
                    >
                      <RefreshCw aria-hidden="true" />
                      {busy === app.slug ? 'Atualizando…' : 'Atualizar agora'}
                    </button>
                    <button
                      className="ac-text-button"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => {
                        setErrorApp(app.slug);
                        setError(null);
                        setConfirmId(app.connectionId);
                      }}
                    >
                      Desconectar
                    </button>
                  </>
                ) : (
                  <button
                    className="ac-button ac-button--secondary"
                    type="button"
                    disabled={!apps.data?.configured || !canWrite || busy !== null}
                    onClick={() => void connect(app.slug)}
                  >
                    {busy === app.slug
                      ? 'Conectando…'
                      : app.status === 'pending'
                        ? 'Continuar autorização'
                        : app.status === 'needs_attention'
                          ? 'Reconectar conta'
                          : 'Conectar conta'}
                    <ExternalLink aria-hidden="true" />
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {apps.data?.configured ? (
        <p className="ac-field-help">
          As consultas atualizam os dados sob demanda. Alterações são revisadas e confirmadas no
          chat. Agenda e tarefas também aparecem na sua rotina do Astra. Os limites gratuitos de
          cada aplicativo continuam valendo.
        </p>
      ) : null}
      <section className="ac-telegram-link">
        <MessageSquare aria-hidden="true" />
        <div>
          <h3>Leve suas conexões para o Telegram</h3>
          <p>
            Use as mesmas contas e o mesmo histórico nos dois canais. Gere um código e envie o
            comando na conversa particular com o bot do Astra.
          </p>
          <button
            className="ac-button ac-button--secondary"
            type="button"
            disabled={!canWrite || busy !== null}
            onClick={() => void linkTelegram()}
          >
            {busy === 'telegram' ? 'Preparando…' : 'Gerar código de vínculo'}
          </button>
          {telegram && (
            <div className="ac-pair-command" role="status">
              <code>{telegram.command}</code>
              <p>Válido por 10 minutos. Não compartilhe esse comando.</p>
              {telegram.botUrl && /^https:\/\/t\.me\/[a-zA-Z0-9_]{5,32}$/.test(telegram.botUrl) && (
                <a
                  className="ac-text-link"
                  href={telegram.botUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Abrir o Astra no Telegram
                  <ExternalLink aria-hidden="true" />
                </a>
              )}
            </div>
          )}
          {error && errorApp === 'telegram' && (
            <p className="ac-field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>
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
