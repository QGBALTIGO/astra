import './approved-life-details.css';
import { useRef, useState } from 'react';
import { ExternalLink, RefreshCw, Mail, Folder } from '../../components/icons';
import {
  CustomerConfirm,
  CustomerDialog,
  CustomerEmpty,
  CustomerError,
  CustomerSkeleton,
} from './components';
import {
  CalendarDays,
  ChevronRight,
  CreditCard,
  FileSpreadsheet,
  Info,
  ListTodo,
  MoreHorizontal,
  Search,
  Send,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import { customerApi } from './api';
import { useCustomerQuery } from './hooks';
import type { CustomerAppSlug, CustomerConnectedApp } from './types';

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
  const [filter, setFilter] = useState('Todos');
  const [search, setSearch] = useState('');
  const [selectedDetails, setDetails] = useState<CustomerConnectedApp | 'telegram' | null>(null);
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

  const appAppearance = {
    gmail: { color: '#d85140', Icon: Mail, kind: 'Comunicação' },
    googlecalendar: { color: '#3578e5', Icon: CalendarDays, kind: 'Produtividade' },
    googledrive: { color: '#209a67', Icon: Folder, kind: 'Arquivos' },
    googlesheets: { color: '#18864b', Icon: FileSpreadsheet, kind: 'Produtividade' },
    todoist: { color: '#d44e43', Icon: ListTodo, kind: 'Produtividade' },
    notion: { color: '#3c4657', Icon: MoreHorizontal, kind: 'Produtividade' },
    trello: { color: '#1679c8', Icon: CreditCard, kind: 'Produtividade' },
  };
  const statusLabel = (app: CustomerConnectedApp) =>
    app.status === 'connected'
      ? 'Conectado'
      : app.status === 'needs_attention'
        ? 'Reconexão necessária'
        : app.status === 'pending'
          ? 'Em autorização'
          : app.status === 'unavailable'
            ? 'Aguardando ativação'
            : 'Não conectado';
  const shown = (apps.data?.apps ?? []).filter(
    (app) =>
      (filter === 'Todos' || appAppearance[app.slug].kind === filter) &&
      (app.name + ' ' + (app.description || ''))
        .toLocaleLowerCase('pt-BR')
        .includes(search.toLocaleLowerCase('pt-BR'))
  );
  const showTelegram =
    (filter === 'Todos' || filter === 'Comunicação') &&
    'Telegram'.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'));
  const details =
    selectedDetails && selectedDetails !== 'telegram'
      ? apps.data?.apps.find((app) => app.slug === selectedDetails.slug) || selectedDetails
      : selectedDetails;
  const DetailIcon = details && details !== 'telegram' ? appAppearance[details.slug].Icon : Send;
  return (
    <div className="approved-life-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SEU UNIVERSO CONECTADO</div>
          <h1>Menos abas. Mais possibilidades.</h1>
          <p>Seus aplicativos favoritos, mais perto do seu assessor pessoal.</p>
        </div>
        <button className="secondary-button" type="button" onClick={apps.retry}>
          <RefreshCw size={17} />
          Atualizar conexões
        </button>
      </div>
      <section className="life-connections-intro">
        <div>
          <span className="life-hero-icon">
            <Unplug size={24} />
          </span>
          <h2>Uma rotina que se conecta.</h2>
          <p>Reúna o que importa em um só lugar, sempre com sua autorização e controle.</p>
        </div>
        <div className="life-trust-copy">
          <ShieldCheck size={22} />
          <span>
            <strong>Você decide o que compartilhar.</strong>
            <small>Acesso com escopo definido e revogação pelo provedor.</small>
          </span>
        </div>
      </section>
      {!apps.data?.configured ? (
        <div className="life-configuration-notice">
          <Info size={19} />
          <div>
            <strong>Integrações aguardando ativação</strong>
            <p>
              A autorização dos aplicativos depende da disponibilidade do serviço. Suas informações
              permanecem separadas e vinculadas somente à sua conta.
            </p>
          </div>
        </div>
      ) : null}
      {error && !errorApp ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="life-catalog-toolbar">
        <div className="segmented-control tabs" role="group" aria-label="Filtrar aplicativos">
          {['Todos', 'Produtividade', 'Comunicação', 'Arquivos'].map((value) => (
            <button
              type="button"
              key={value}
              className={filter === value ? 'active' : ''}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <label className="life-search">
          <Search size={17} />
          <input
            aria-label="Buscar aplicativo"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar aplicativo"
          />
        </label>
      </div>
      <div className="life-app-grid">
        {shown.map((app) => {
          const { Icon, color } = appAppearance[app.slug];
          return (
            <article className="panel life-app-card" key={app.slug} aria-label={app.name}>
              <div className="life-app-heading">
                <span className="life-app-icon" style={{ color }}>
                  <Icon size={26} strokeWidth={1.8} />
                </span>
                <span className={`badge ${app.status === 'connected' ? 'success' : 'neutral'}`}>
                  {statusLabel(app)}
                </span>
              </div>
              <h2>{app.name}</h2>
              <p>
                {app.description ||
                  'Conecte sua conta para utilizar os recursos deste aplicativo no Astra.'}
              </p>
              <button className="secondary-button" type="button" onClick={() => setDetails(app)}>
                Ver detalhes
                <ChevronRight size={16} />
              </button>
            </article>
          );
        })}
        {showTelegram ? (
          <article className="panel life-app-card" aria-label="Telegram">
            <div className="life-app-heading">
              <span className="life-app-icon" style={{ color: '#289bc8' }}>
                <Send size={26} strokeWidth={1.8} />
              </span>
              <span className="badge">Vínculo seguro</span>
            </div>
            <h2>Telegram</h2>
            <p>Mais um canal para conversar com o Astra, com suas contas e seu histórico.</p>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setDetails('telegram')}
            >
              Ver detalhes
              <ChevronRight size={16} />
            </button>
          </article>
        ) : null}
      </div>
      {!shown.length && !showTelegram ? (
        <section className="panel">
          <CustomerEmpty title="Nenhum aplicativo encontrado">
            Tente buscar outro nome ou trocar o filtro.
          </CustomerEmpty>
        </section>
      ) : null}
      {details ? (
        <CustomerDialog
          title={details === 'telegram' ? 'Telegram' : details.name}
          onClose={() => setDetails(null)}
        >
          <div className="life-connection-status">
            <span
              className="life-app-icon"
              style={{
                color: details === 'telegram' ? '#289bc8' : appAppearance[details.slug].color,
              }}
            >
              <DetailIcon size={30} />
            </span>
            <div>
              <span className="badge">
                {details === 'telegram' ? 'Vínculo por código' : statusLabel(details)}
              </span>
              <p>
                {details === 'telegram'
                  ? 'Converse com o Astra em mais um canal.'
                  : details.description}
              </p>
            </div>
          </div>
          {details === 'telegram' ? (
            <>
              <h3>Leve suas conexões para o Telegram</h3>
              <p>
                Gere um código e envie o comando na conversa particular com o bot do Astra. Não
                compartilhe esse comando.
              </p>
              <button
                className="secondary-button"
                type="button"
                disabled={!canWrite || busy !== null}
                onClick={() => void linkTelegram()}
              >
                {busy === 'telegram' ? 'Preparando…' : 'Gerar código de vínculo'}
              </button>
              {telegram ? (
                <div className="approved-connection-code" role="status">
                  <code>{telegram.command}</code>
                  <p>
                    Válido até{' '}
                    {new Intl.DateTimeFormat('pt-BR', {
                      timeStyle: 'short',
                      ...(apps.data?.timeZone ? { timeZone: apps.data.timeZone } : {}),
                    }).format(new Date(telegram.expiresAt))}
                    .
                  </p>
                  {telegram.botUrl &&
                  /^https:\/\/t\.me\/[a-zA-Z0-9_]{5,32}$/.test(telegram.botUrl) ? (
                    <a
                      className="text-button"
                      href={telegram.botUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Abrir o Astra no Telegram
                      <ExternalLink size={16} />
                    </a>
                  ) : null}
                </div>
              ) : null}
              {error && errorApp === 'telegram' ? (
                <p className="field-error" role="alert">
                  {error}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <ul className="life-permission-list">
                <li>
                  <ShieldCheck size={17} />A autorização acontece diretamente no provedor.
                </li>
                <li>
                  <ShieldCheck size={17} />
                  Você pode revogar o acesso quando precisar.
                </li>
              </ul>
              {details.status === 'connected' ? (
                <div className="life-configuration-notice">
                  <RefreshCw size={18} />
                  <p>
                    {details.lastSyncedAt
                      ? 'Atualizado em ' +
                        new Intl.DateTimeFormat('pt-BR', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                          ...(apps.data?.timeZone ? { timeZone: apps.data.timeZone } : {}),
                        }).format(new Date(details.lastSyncedAt))
                      : 'Pronto para a primeira consulta'}
                    {details.itemCount !== undefined
                      ? ` · ${details.itemCount} registros sincronizados`
                      : ''}
                  </p>
                </div>
              ) : null}
              {details.syncIssue ? (
                <p className="field-error" role="status">
                  {details.syncIssue}
                </p>
              ) : null}
              {error && errorApp === details.slug ? (
                <p className="field-error" role="alert">
                  {error}
                </p>
              ) : null}
              {notice?.app === details.slug ? (
                <p className="form-hint" role="status">
                  {notice.text}
                </p>
              ) : null}
              <div className="life-modal-footer">
                {details.status === 'connected' && details.connectionId ? (
                  <>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => {
                        setErrorApp(details.slug);
                        setError(null);
                        setConfirmId(details.connectionId);
                      }}
                    >
                      Desconectar
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={!canWrite || busy !== null}
                      onClick={() => void sync(details.slug)}
                    >
                      <RefreshCw size={16} />
                      {busy === details.slug ? 'Atualizando…' : 'Atualizar agora'}
                    </button>
                  </>
                ) : (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={
                      !apps.data?.configured ||
                      !canWrite ||
                      busy !== null ||
                      details.status === 'unavailable'
                    }
                    onClick={() => void connect(details.slug)}
                  >
                    {busy === details.slug
                      ? 'Conectando…'
                      : details.status === 'pending'
                        ? 'Continuar autorização'
                        : details.status === 'needs_attention'
                          ? 'Reconectar conta'
                          : 'Conectar conta'}
                    <ExternalLink size={16} />
                  </button>
                )}
              </div>
            </>
          )}
        </CustomerDialog>
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
    </div>
  );
}
