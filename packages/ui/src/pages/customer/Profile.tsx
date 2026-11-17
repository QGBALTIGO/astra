import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Download,
  ExternalLink,
  LogOut,
  Monitor,
  Moon,
  ShieldCheck,
  Sun,
} from '../../components/icons';
import { useNavigate, useLocation } from 'react-router';
import { formatWhatsAppPhone } from '../channels-access-helpers';
import { customerApi, downloadCustomerExport } from './api';
import { CustomerAvatar, CustomerConfirm, CustomerError, CustomerSkeleton } from './components';
import { dateTimeLabel, safeLink, TIME_ZONES, timeZoneLabel, validTimeZone } from './helpers';
import { useCustomerQuery } from './hooks';
import { CustomerPhoneChange } from './PhoneChange';
import { planAccessState } from './PlanAccess';
import { PageHeading, SectionTabs, Badge, Modal } from './approved-profile-referral-ui';
import {
  UserRound,
  Palette,
  CheckCircle2,
  LockKeyhole,
  ArrowRight,
  ChevronRight,
} from 'lucide-react';
import { useCustomerTheme } from './hooks';
import type { Customer, CustomerSession } from './types';

export type CustomerPreferenceKey = 'displayName' | 'timeZone' | 'theme' | 'hideAmounts';

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
  onUpdated: (
    profile: Customer,
    baseline: Customer,
    fields?: readonly CustomerPreferenceKey[]
  ) => void;
  onChanged: (message: string) => void;
  onSignOut: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (
      active &&
      (new URLSearchParams(location.search).get('integracoes') === '1' ||
        location.hash === '#conexoes')
    )
      navigate('/cliente/conexoes', { replace: true });
  }, [active, location.search, location.hash, navigate]);
  const profile = useCustomerQuery(
    'profile',
    async (signal) => {
      const baseline = customer;
      const result = await customerApi.profile(signal);
      return { ...result, baseline };
    },
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
  const [tab, setTab] = useState<'general' | 'preferences' | 'privacy' | 'access'>('general');
  const [sessionsOpen, setSessionsOpen] = useState(false),
    [exportOpen, setExportOpen] = useState(false);
  const [name, setName] = useState(customer.displayName),
    [zone, setZone] = useState(customer.timeZone);
  const resolvedTheme = useCustomerTheme(customer.theme);
  const [phoneChange, setPhoneChange] = useState(false);
  const phoneChangeBaseline = useRef<Customer | null>(null);
  const [revoke, setRevoke] = useState<CustomerSession | 'others' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const lock = useRef(false);
  const current = customer;
  useEffect(() => {
    if (profile.data) onUpdated(profile.data.profile, profile.data.baseline);
  }, [profile.data, onUpdated]);
  const renewalUrl = safeLink(integrations.data?.renewalUrl) ?? 'https://pay.cakto.com.br/CubL455';
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
  const access = planAccessState(current);
  useEffect(() => {
    setName(current.displayName);
    setZone(current.timeZone);
  }, [current.displayName, current.timeZone]);
  useEffect(() => {
    if (active && new URLSearchParams(location.search).get('secao') === 'plano') setTab('access');
  }, [active, location.search]);
  const updatePreferences = async (
    input: Partial<Pick<Customer, 'displayName' | 'timeZone' | 'theme' | 'hideAmounts'>>
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy('profile');
    setError(null);
    const baseline = customer;
    try {
      const result = await customerApi.updateProfile(input);
      onUpdated(result.profile, baseline, Object.keys(input) as CustomerPreferenceKey[]);
      onChanged('Preferências atualizadas.');
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Não foi possível salvar suas preferências.'
      );
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  const saveGeneral = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !validTimeZone(zone))
      return setError('Informe seu nome e um fuso horário válido.');
    void updatePreferences({ displayName: name.trim(), timeZone: zone });
  };
  return (
    <div className="ac-page approved-profile">
      <PageHeading
        eyebrow="DO SEU JEITO"
        title="Meu perfil"
        description="Um espaço que acompanha suas preferências."
      />
      {error && <CustomerError error={new Error(error)} />}
      {profile.error && <CustomerError error={profile.error} onRetry={profile.retry} />}
      <div className="profile-layout">
        <SectionTabs
          items={[
            { id: 'general', label: 'Geral' },
            { id: 'preferences', label: 'Preferências' },
            { id: 'privacy', label: 'Privacidade' },
            { id: 'access', label: 'Plano e acesso' },
          ]}
          value={tab}
          onChange={setTab}
          label="Configurações do perfil"
          prefix="profile"
        />
        <div
          className="settings-content"
          id="profile-content"
          role="tabpanel"
          aria-labelledby={`profile-tab-${tab}`}
        >
          {tab === 'general' ? (
            <section className="panel settings-panel">
              <div className="section-heading">
                <div>
                  <h2>Informações pessoais</h2>
                  <p>Como você quer ser chamado pelo Astra.</p>
                </div>
                {avatarUrl ? (
                  <CustomerAvatar displayName={current.displayName} url={avatarUrl} />
                ) : (
                  <UserRound size={22} />
                )}
              </div>
              <form onSubmit={saveGeneral} aria-busy={busy === 'profile'}>
                <div className="form-grid">
                  <label className="field">
                    Nome
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                      maxLength={120}
                      autoComplete="name"
                      disabled={Boolean(busy)}
                    />
                  </label>
                  <label className="field">
                    Telefone
                    <input
                      value={formatWhatsAppPhone(current.phoneNumber)}
                      readOnly
                      autoComplete="tel"
                    />
                  </label>
                </div>
                <label className="field">
                  Fuso horário
                  <select
                    value={zone}
                    onChange={(event) => setZone(event.target.value)}
                    disabled={Boolean(busy)}
                  >
                    {!TIME_ZONES.some(([value]) => value === zone) && (
                      <option value={zone}>{timeZoneLabel(zone)}</option>
                    )}
                    {TIME_ZONES.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="modal-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={Boolean(busy) || !current.access.canWrite}
                    onClick={() => {
                      phoneChangeBaseline.current = customer;
                      setPhoneChange(true);
                    }}
                  >
                    Alterar telefone
                  </button>
                  <button className="primary-button" disabled={Boolean(busy)}>
                    {busy === 'profile' ? 'Salvando…' : 'Salvar preferências'}
                  </button>
                </div>
              </form>
            </section>
          ) : tab === 'preferences' ? (
            <section className="panel settings-panel">
              <div className="section-heading">
                <div>
                  <h2>Um Astra com a sua cara</h2>
                  <p>Conforto visual em cada detalhe.</p>
                </div>
                <Palette size={22} />
              </div>
              <h3 className="setting-label">Aparência</h3>
              <div className="theme-options">
                {(['light', 'dark'] as const).map((theme) => (
                  <button
                    type="button"
                    key={theme}
                    className={resolvedTheme === theme ? 'selected' : ''}
                    disabled={Boolean(busy)}
                    aria-pressed={resolvedTheme === theme}
                    onClick={() => void updatePreferences({ theme })}
                  >
                    <div className={`theme-preview ${theme}`}>
                      <i />
                      <div>
                        <i />
                        <i />
                        <i />
                      </div>
                    </div>
                    <span>
                      {theme === 'light' ? <Sun size={16} /> : <Moon size={16} />}Tema{' '}
                      {theme === 'light' ? 'claro' : 'escuro'}
                      {resolvedTheme === theme && <CheckCircle2 size={17} />}
                    </span>
                  </button>
                ))}
              </div>
              <div className="setting-row">
                <div>
                  <strong>Ocultar valores ao abrir</strong>
                  <p>Sua preferência acompanha sua conta.</p>
                </div>
                <button
                  type="button"
                  className={`toggle ${current.hideAmounts ? 'on' : ''}`}
                  disabled={Boolean(busy)}
                  onClick={() => void updatePreferences({ hideAmounts: !current.hideAmounts })}
                  role="switch"
                  aria-checked={current.hideAmounts}
                  aria-label="Ocultar valores financeiros"
                >
                  <span />
                </button>
              </div>
              <div className="setting-row">
                <div>
                  <strong>Seguir a aparência do aparelho</strong>
                  <p>Alterna automaticamente entre claro e escuro.</p>
                </div>
                <button
                  type="button"
                  className={`toggle ${current.theme === 'system' ? 'on' : ''}`}
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void updatePreferences({
                      theme: current.theme === 'system' ? resolvedTheme : 'system',
                    })
                  }
                  role="switch"
                  aria-checked={current.theme === 'system'}
                  aria-label="Seguir aparência do aparelho"
                >
                  <span />
                </button>
              </div>
            </section>
          ) : tab === 'privacy' ? (
            <section className="panel settings-panel">
              <div className="section-heading">
                <div>
                  <h2>Seus dados, seu controle</h2>
                  <p>Transparência em todas as escolhas.</p>
                </div>
                <ShieldCheck size={22} />
              </div>
              <button
                type="button"
                className="setting-row setting-button"
                aria-label="Sessões e aparelhos"
                onClick={() => setSessionsOpen(true)}
              >
                <div>
                  <strong>Sessões e aparelhos</strong>
                  <p>Confira os acessos e encerre uma sessão quando precisar.</p>
                </div>
                <ChevronRight size={18} />
              </button>
              <button
                type="button"
                className="setting-row setting-button"
                aria-label="Exportar meus dados"
                onClick={() => setExportOpen(true)}
              >
                <div>
                  <strong>Exportar meus dados</strong>
                  <p>Baixe seus registros em CSV ou JSON.</p>
                </div>
                <Download size={18} />
              </button>
            </section>
          ) : (
            <section className="panel settings-panel">
              <div className="section-heading">
                <div>
                  <h2>Plano e acesso</h2>
                  <p>Suas informações sempre com clareza.</p>
                </div>
                <LockKeyhole size={22} />
              </div>
              <section
                className="access-card"
                aria-label="Validade do plano"
                data-status={access.status}
              >
                <span className="soft-icon">
                  <ShieldCheck size={27} />
                </span>
                <h3>{access.label}</h3>
                <p>{access.remaining}</p>
                <Badge tone={access.status === 'expired' ? 'warning' : 'success'}>
                  {access.status === 'expired' ? 'Acesso somente leitura' : 'Acesso ativo'}
                </Badge>
              </section>
              <dl className="detail-list">
                <div>
                  <dt>Vencimento</dt>
                  <dd>{access.dateLabel}</dd>
                </div>
                <div>
                  <dt>Seu acesso</dt>
                  <dd>{current.access.canWrite ? 'Consulta e edição' : 'Consulta e exportação'}</dd>
                </div>
              </dl>
              {integrations.error ? (
                <CustomerError error={integrations.error} onRetry={integrations.retry} />
              ) : integrations.loading && !integrations.data ? (
                <CustomerSkeleton label="Carregando opções de renovação…" />
              ) : (
                <a
                  className="primary-button"
                  href={renewalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Renovar meu plano
                  <ArrowRight size={16} />
                </a>
              )}
              {supportUrl && (
                <a
                  className="text-button"
                  href={supportUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Preciso de ajuda
                  <ExternalLink size={15} />
                </a>
              )}
            </section>
          )}
          <div className="profile-signout">
            <button
              className="secondary-button"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void signOut()}
            >
              <LogOut size={17} />
              {busy === 'logout' ? 'Saindo…' : 'Sair deste aparelho'}
            </button>
          </div>
        </div>
      </div>
      {sessionsOpen && (
        <Modal
          title="Sessões e aparelhos"
          subtitle="Confira os acessos à sua conta."
          onClose={() => setSessionsOpen(false)}
          busy={busy === 'revoke'}
        >
          {sessions.error ? (
            <CustomerError error={sessions.error} onRetry={sessions.retry} />
          ) : sessions.loading && !sessions.data ? (
            <CustomerSkeleton />
          ) : (
            <ul className="ac-session-list">
              {sessions.data?.sessions.map((session) => (
                <li key={session.id}>
                  <Monitor aria-hidden="true" />
                  <div>
                    <strong>{session.label}</strong>
                    <span>
                      Último acesso em {dateTimeLabel(session.lastSeenAt, current.timeZone)}
                    </span>
                    {session.current && <small>Este aparelho</small>}
                  </div>
                  {!session.current && (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setRevoke(session);
                        setRevokeError(null);
                      }}
                    >
                      Encerrar sessão
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setSessionsOpen(false)}
              disabled={Boolean(busy)}
            >
              Voltar
            </button>
            <button
              className="primary-button"
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
          </div>
        </Modal>
      )}
      {exportOpen && (
        <Modal
          title="Exportar meus dados"
          subtitle="Escolha o formato do seu arquivo."
          onClose={() => setExportOpen(false)}
          busy={Boolean(busy)}
        >
          <p className="form-hint">O arquivo é preparado com os registros reais da sua conta.</p>
          <div className="modal-actions transaction-form-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void exportData('csv')}
            >
              <Download size={16} />
              {busy === 'csv' ? 'Exportando…' : 'Exportar CSV'}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void exportData('json')}
            >
              <Download size={16} />
              {busy === 'json' ? 'Exportando…' : 'Exportar JSON'}
            </button>
          </div>
          {error && <CustomerError error={new Error(error)} />}
        </Modal>
      )}
      {phoneChange && (
        <CustomerPhoneChange
          canWrite={current.access.canWrite}
          onClose={() => setPhoneChange(false)}
          onChanged={(updated) => {
            onUpdated(updated, phoneChangeBaseline.current ?? customer, []);
            setPhoneChange(false);
            onChanged('Número atualizado. Seu histórico foi preservado.');
          }}
        />
      )}
      {revoke && (
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
      )}
    </div>
  );
}
