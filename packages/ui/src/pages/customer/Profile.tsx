import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  Calendar,
  Download,
  Edit3,
  ExternalLink,
  Globe,
  LogOut,
  Monitor,
  MessageSquare,
  Moon,
  ShieldCheck,
  Sun,
} from '../../components/icons';
import { useNavigate } from 'react-router';
import { formatWhatsAppPhone } from '../channels-access-helpers';
import { customerApi, downloadCustomerExport } from './api';
import {
  CustomerAvatar,
  CustomerConfirm,
  CustomerDialog,
  CustomerError,
  CustomerSkeleton,
} from './components';
import {
  dateTimeLabel,
  fullDate,
  safeLink,
  TIME_ZONES,
  timeZoneLabel,
  validTimeZone,
} from './helpers';
import { useCustomerQuery } from './hooks';
import { CustomerPhoneChange } from './PhoneChange';
import type { Customer, CustomerSession, CustomerTheme } from './types';

export function CustomerProfile({
  customer,
  avatarUrl,
  active,
  revision,
  onUpdated,
  onChanged,
  onSignOut,
}: {
  customer: Customer;
  avatarUrl: string | null;
  active: boolean;
  revision: number;
  onUpdated: (profile: Customer) => void;
  onChanged: (message: string) => void;
  onSignOut: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const profile = useCustomerQuery(
    'profile',
    (signal) => customerApi.profile(signal),
    active,
    revision
  );
  const integrations = useCustomerQuery(
    'integrations',
    (signal) => customerApi.integrations(signal),
    active,
    revision
  );
  const sessions = useCustomerQuery(
    'sessions',
    (signal) => customerApi.sessions(signal),
    active,
    revision
  );
  const [editing, setEditing] = useState(false);
  const [phoneChange, setPhoneChange] = useState(false);
  const [revoke, setRevoke] = useState<CustomerSession | 'others' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const lock = useRef(false);
  const current = customer;
  useEffect(() => {
    if (profile.data) onUpdated(profile.data.profile);
  }, [profile.data, onUpdated]);
  const siteUrl = safeLink(integrations.data?.siteUrl);
  const renewalUrl = safeLink(integrations.data?.renewalUrl) ?? siteUrl;
  const supportUrl = safeLink(integrations.data?.supportUrl);
  const exportData = async (format: 'json' | 'csv') => {
    if (lock.current) return;
    lock.current = true;
    setBusy(format);
    setError(null);
    try {
      await downloadCustomerExport(format);
      onChanged('Exportação preparada. Confira os downloads do navegador.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível exportar.');
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  const revokeSessions = async () => {
    if (lock.current || !revoke) return;
    lock.current = true;
    setBusy('revoke');
    setRevokeError(null);
    try {
      if (revoke === 'others') await customerApi.revokeOtherSessions();
      else {
        const result = await customerApi.revokeSession(revoke.id);
        if (result.current) {
          navigate('/cliente/entrar', { replace: true });
          return;
        }
      }
      setRevoke(null);
      sessions.retry();
      onChanged('Sessões encerradas.');
    } catch (failure) {
      setRevokeError(
        failure instanceof Error ? failure.message : 'Não foi possível encerrar a sessão.'
      );
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  const signOut = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy('logout');
    setError(null);
    try {
      await onSignOut();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Não foi possível sair. Tente novamente.'
      );
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  return (
    <div className="ac-page">
      <header className="ac-page-heading">
        <div>
          <p className="ac-eyebrow">DO SEU JEITO</p>
          <h1>Perfil</h1>
          <p>Sua conta, suas preferências e seu acesso.</p>
        </div>
      </header>
      {error ? <CustomerError error={error} /> : null}
      {profile.error ? <CustomerError error={profile.error} onRetry={profile.retry} /> : null}
      <div className="ac-profile-columns">
        <div className="ac-profile-column">
          <section className="ac-card">
            <div className="ac-profile-identity">
              <CustomerAvatar displayName={current.displayName} url={avatarUrl} large />
              <div>
                <h2>{current.displayName || 'Sua conta'}</h2>
                <p>{formatWhatsAppPhone(current.phoneNumber)}</p>
              </div>
              <button
                type="button"
                className="ac-icon-button"
                aria-label="Editar perfil"
                onClick={() => setEditing(true)}
              >
                <Edit3 aria-hidden="true" />
              </button>
            </div>
            <dl className="ac-profile-facts">
              <div>
                <dt>Fuso horário</dt>
                <dd>{timeZoneLabel(current.timeZone)}</dd>
              </div>
              <div>
                <dt>Moeda</dt>
                <dd>Real brasileiro (BRL)</dd>
              </div>
              <div>
                <dt>Aparência</dt>
                <dd>
                  {{ light: 'Clara', dark: 'Escura', system: 'Igual ao aparelho' }[current.theme]}
                </dd>
              </div>
              <div>
                <dt>Privacidade visual</dt>
                <dd>{current.hideAmounts ? 'Valores ocultos' : 'Valores visíveis'}</dd>
              </div>
            </dl>
            <div className="ac-card-actions">
              <button
                className="ac-button ac-button--secondary"
                type="button"
                onClick={() => setEditing(true)}
              >
                Editar preferências
              </button>
              <button
                className="ac-text-button"
                type="button"
                disabled={!current.access.canWrite}
                onClick={() => setPhoneChange(true)}
              >
                Alterar telefone
              </button>
            </div>
          </section>
          <section className="ac-card ac-plan-card">
            <div className="ac-card-heading">
              <div>
                <p className="ac-eyebrow">SEU ACESSO AO ASTRA</p>
                <h2>Meu plano</h2>
              </div>
              <ShieldCheck aria-hidden="true" />
            </div>
            <span
              className={
                'ac-status ac-status--' +
                (current.access.status === 'active' ? 'settled' : 'pending')
              }
            >
              {current.access.status === 'active' ? 'Acesso ativo' : 'Acesso vencido'}
            </span>
            <p className="ac-plan-expiry">
              {current.access.expiresAt
                ? `Válido até ${fullDate(current.access.expiresAt, current.timeZone)}`
                : 'Acesso sem vencimento'}
            </p>
            <p className="ac-muted">
              {current.access.canWrite
                ? 'Você pode consultar e organizar seus registros pelo WhatsApp e pelo painel.'
                : 'Seus registros continuam disponíveis para consulta e exportação. Renove para voltar a criar e editar.'}
            </p>
            {integrations.error ? (
              <CustomerError error={integrations.error} onRetry={integrations.retry} />
            ) : integrations.loading && !integrations.data ? (
              <p role="status" className="ac-loading-copy">
                Carregando opções de renovação…
              </p>
            ) : renewalUrl ? (
              <a href={renewalUrl} target="_blank" rel="noopener noreferrer" className="ac-button">
                {integrations.data?.renewalUrl ? 'Renovar acesso' : 'Ver opções de renovação'}
                <ExternalLink aria-hidden="true" />
              </a>
            ) : (
              <p className="ac-field-help">Para renovar, fale com o administrador do seu acesso.</p>
            )}
          </section>
          <section className="ac-card">
            <div className="ac-card-heading">
              <div>
                <h2>Integrações</h2>
                <p>Conexões disponíveis para sua conta.</p>
              </div>
              <Globe aria-hidden="true" />
            </div>
            {integrations.error ? (
              <CustomerError error={integrations.error} onRetry={integrations.retry} />
            ) : integrations.loading && !integrations.data ? (
              <CustomerSkeleton />
            ) : integrations.data ? (
              <>
                {integrations.data.whatsapp ? (
                  <div className="ac-integration">
                    <MessageSquare aria-hidden="true" />
                    <div>
                      <h3>WhatsApp</h3>
                      <span className="ac-status">
                        {integrations.data.whatsapp.status === 'connected'
                          ? 'Conectado'
                          : integrations.data.whatsapp.status === 'disconnected'
                            ? 'Desconectado'
                            : 'Indisponível'}
                      </span>
                      <p>
                        {integrations.data.whatsapp.connected
                          ? 'Seus registros enviados ao Astra também aparecem neste painel.'
                          : 'O canal está indisponível no momento. Seus registros continuam disponíveis no painel.'}
                      </p>
                    </div>
                  </div>
                ) : null}
                <div className="ac-integration">
                  <Calendar aria-hidden="true" />
                  <div>
                    <h3>Google Agenda</h3>
                    <span className="ac-status">
                      {integrations.data.googleCalendar.status === 'connected'
                        ? 'Conectado'
                        : integrations.data.googleCalendar.status === 'needs_attention'
                          ? 'Precisa de atenção'
                          : integrations.data.googleCalendar.available
                            ? 'Não conectado'
                            : 'Indisponível'}
                    </span>
                    <p>{integrations.data.googleCalendar.message}</p>
                  </div>
                </div>
              </>
            ) : null}
          </section>
        </div>
        <div className="ac-profile-column">
          <section className="ac-card">
            <div className="ac-card-heading">
              <div>
                <h2>Aparelhos conectados</h2>
                <p>Controle onde sua conta está aberta.</p>
              </div>
              <Monitor aria-hidden="true" />
            </div>
            {sessions.error ? (
              <CustomerError error={sessions.error} onRetry={sessions.retry} />
            ) : sessions.loading && !sessions.data ? (
              <CustomerSkeleton />
            ) : (
              <ul className="ac-sessions">
                {sessions.data?.sessions.map((session) => (
                  <li key={session.id}>
                    <Monitor aria-hidden="true" />
                    <div>
                      <strong>{session.label || 'Navegador'}</strong>
                      {session.current ? (
                        <span className="ac-current-session">Este aparelho</span>
                      ) : null}
                      <small>
                        Último acesso: {dateTimeLabel(session.lastSeenAt, current.timeZone)}
                      </small>
                    </div>
                    {!session.current ? (
                      <button
                        className="ac-icon-button"
                        type="button"
                        aria-label={'Encerrar sessão ' + session.label}
                        disabled={Boolean(busy)}
                        onClick={() => {
                          setRevoke(session);
                          setRevokeError(null);
                        }}
                      >
                        <LogOut aria-hidden="true" />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <button
              className="ac-button ac-button--secondary"
              type="button"
              disabled={
                Boolean(busy) || !sessions.data?.sessions.some((session) => !session.current)
              }
              onClick={() => {
                setRevoke('others');
                setRevokeError(null);
              }}
            >
              Encerrar outras sessões
            </button>
          </section>
          <section className="ac-card">
            <div className="ac-card-heading">
              <div>
                <h2>Seus dados</h2>
                <p>Transações em reais, compromissos, tarefas e lembretes.</p>
              </div>
              <Download aria-hidden="true" />
            </div>
            <div className="ac-export-actions">
              <button
                className="ac-button ac-button--secondary"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void exportData('csv')}
              >
                <Download aria-hidden="true" />
                {busy === 'csv' ? 'Exportando…' : 'Exportar CSV'}
              </button>
              <button
                className="ac-button ac-button--secondary"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void exportData('json')}
              >
                <Download aria-hidden="true" />
                {busy === 'json' ? 'Exportando…' : 'Exportar JSON'}
              </button>
            </div>
          </section>
          <section className="ac-card">
            <h2>Precisa de ajuda?</h2>
            <p className="ac-muted">
              Fale com quem administra seu acesso para tirar dúvidas ou pedir ajuda com sua conta.
            </p>
            {supportUrl ? (
              <a
                className="ac-text-link"
                href={supportUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Falar com o suporte
                <ExternalLink aria-hidden="true" />
              </a>
            ) : null}
            {siteUrl ? (
              <a className="ac-text-link" href={siteUrl} target="_blank" rel="noopener noreferrer">
                Acessar o site do Astra
                <ExternalLink aria-hidden="true" />
              </a>
            ) : null}
          </section>
          <button
            className="ac-button ac-button--secondary ac-logout"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void signOut()}
          >
            <LogOut aria-hidden="true" />
            {busy === 'logout' ? 'Saindo…' : 'Sair deste aparelho'}
          </button>
        </div>
      </div>
      {editing ? (
        <ProfileEditor
          customer={current}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            onUpdated(updated);
            setEditing(false);
            onChanged('Preferências atualizadas.');
          }}
        />
      ) : null}
      {phoneChange ? (
        <CustomerPhoneChange
          canWrite={current.access.canWrite}
          onClose={() => setPhoneChange(false)}
          onChanged={(updated) => {
            onUpdated(updated);
            setPhoneChange(false);
            onChanged('Número atualizado. Seu histórico foi preservado.');
          }}
        />
      ) : null}
      {revoke ? (
        <CustomerConfirm
          title="Encerrar sessões?"
          action={revoke === 'others' ? 'Encerrar outras sessões' : 'Encerrar sessão'}
          onClose={() => setRevoke(null)}
          onConfirm={() => void revokeSessions()}
          busy={busy === 'revoke'}
          error={revokeError}
        >
          {revoke === 'others'
            ? 'Os outros aparelhos precisarão confirmar um novo código para acessar sua conta. Este aparelho continuará conectado.'
            : `O aparelho “${revoke.label}” precisará confirmar um novo código para acessar sua conta.`}
        </CustomerConfirm>
      ) : null}
    </div>
  );
}

function ProfileEditor({
  customer,
  onClose,
  onSaved,
}: {
  customer: Customer;
  onClose: () => void;
  onSaved: (customer: Customer) => void;
}) {
  const id = useId();
  const [displayName, setDisplayName] = useState(customer.displayName);
  const [timeZone, setTimeZone] = useState(customer.timeZone);
  const [theme, setTheme] = useState<CustomerTheme>(customer.theme);
  const [hideAmounts, setHideAmounts] = useState(customer.hideAmounts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current) return;
    if (!displayName.trim() || !validTimeZone(timeZone.trim())) {
      setError('Informe seu nome e um fuso horário válido.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await customerApi.updateProfile({
        displayName: displayName.trim(),
        timeZone: timeZone.trim(),
        theme,
        hideAmounts,
      });
      onSaved(result.profile);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Não foi possível salvar suas preferências.'
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <CustomerDialog
      title="Seu perfil e suas preferências"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button
            className="ac-button ac-button--secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </button>
          <button className="ac-button" form={id} type="submit" disabled={busy}>
            {busy ? 'Salvando…' : 'Salvar preferências'}
          </button>
        </>
      }
    >
      <form id={id} className="ac-form" onSubmit={submit} noValidate aria-busy={busy}>
        <fieldset disabled={busy}>
          <label>
            Como você quer ser chamado?
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={120}
              required
              autoComplete="name"
            />
          </label>
          <label>
            Fuso horário
            <input
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              list={id + '-zones'}
              required
              maxLength={100}
            />
          </label>
          <datalist id={id + '-zones'}>
            {TIME_ZONES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </datalist>
          <p className="ac-field-help">
            Os instantes dos compromissos existentes são preservados. Eles passarão a ser exibidos
            no fuso escolhido.
          </p>
          <fieldset className="ac-theme-options">
            <legend>Aparência</legend>
            {(
              [
                ['light', 'Clara', Sun],
                ['dark', 'Escura', Moon],
                ['system', 'Sistema', Monitor],
              ] as const
            ).map(([value, label, Icon]) => (
              <label key={value}>
                <input
                  type="radio"
                  name={id + '-theme'}
                  value={value}
                  checked={theme === value}
                  onChange={() => setTheme(value)}
                />
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <label className="ac-checkbox-label">
            <input
              type="checkbox"
              checked={hideAmounts}
              onChange={(event) => setHideAmounts(event.target.checked)}
            />
            Ocultar valores ao usar o painel
          </label>
        </fieldset>
        {error ? <CustomerError error={error} /> : null}
      </form>
    </CustomerDialog>
  );
}
