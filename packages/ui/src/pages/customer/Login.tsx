import { useRef, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import {
  ArrowLeft,
  Calendar,
  Check,
  Lock,
  MessageSquare,
  Receipt,
  ShieldCheck,
} from '../../components/icons';
import { CustomerApiError, customerApi } from './api';
import { CustomerBrand, CustomerError } from './components';
import {
  CustomerCodeField,
  CustomerPhoneField,
  countdownLabel,
  maskedPhone,
  normalizeWhatsAppPhone,
} from './AccessForms';
import { useCountdown, useCustomerQuery, useCustomerTheme } from './hooks';
import type { Customer, CustomerChallenge } from './types';

export function CustomerLogin() {
  const session = useCustomerQuery('login-session', (signal) => customerApi.session(signal));
  const [authenticated, setAuthenticated] = useState<Customer | null>(null);
  const theme = useCustomerTheme();
  const [phone, setPhone] = useState('');
  const [confirmedPhone, setConfirmedPhone] = useState('');
  const [challenge, setChallenge] = useState<CustomerChallenge | null>(null);
  const [code, setCode] = useState('');
  const [retryAt, setRetryAt] = useState(0);
  const [expiresAt, setExpiresAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const retryIn = useCountdown(retryAt);
  const expiresIn = useCountdown(expiresAt);
  const requestCode = async () => {
    if (lock.current || retryIn > 0) return;
    const normalized = normalizeWhatsAppPhone(phone);
    if (!normalized) {
      setError('Informe um número válido com DDD. Para outro país, inclua + e o DDI.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await customerApi.requestCode(normalized);
      setConfirmedPhone(normalized);
      setChallenge(result);
      setCode('');
      setRetryAt(Date.now() + result.retryAfter * 1000);
      setExpiresAt(Date.now() + result.expiresIn * 1000);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível solicitar o código.');
      if (failure instanceof CustomerApiError && failure.retryAfter)
        setRetryAt(Date.now() + failure.retryAfter * 1000);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) {
      await requestCode();
      return;
    }
    if (lock.current || !/^\d{6}$/.test(code) || !expiresIn) {
      if (!lock.current)
        setError(
          !expiresIn
            ? 'Este código expirou. Solicite um novo código.'
            : 'Digite os 6 dígitos recebidos pelo WhatsApp.'
        );
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await customerApi.verifyCode(challenge.challengeId, code);
      setAuthenticated(result.customer);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível validar o código.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (authenticated || session.data?.customer) return <Navigate to="/cliente" replace />;
  return (
    <div className="astra-customer ac-login" data-theme={theme}>
      <div className="ac-login-layout">
        <section className="ac-login-story">
          <CustomerBrand />
          <span className="ac-eyebrow">SEU ASSISTENTE PESSOAL</span>
          <h1>
            Sua rotina,
            <br />
            mais <em>leve.</em>
          </h1>
          <p>
            Seu dinheiro, seus planos e seus compromissos. Tudo o que você organiza com o Astra, em
            um espaço só seu.
          </p>
          <ul>
            <li>
              <Receipt aria-hidden="true" />
              <span>Finanças que fazem sentido.</span>
            </li>
            <li>
              <Calendar aria-hidden="true" />
              <span>Seus próximos passos em dia.</span>
            </li>
            <li>
              <ShieldCheck aria-hidden="true" />
              <span>Um espaço só seu.</span>
            </li>
          </ul>
          <a
            className="ac-text-link"
            href="https://astra-landing-production.up.railway.app/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Conheça o Astra
          </a>
        </section>
        <main className="ac-login-card">
          <div className="ac-login-mobile-brand">
            <CustomerBrand />
          </div>
          <p className="ac-eyebrow ac-login-form-eyebrow">
            <Lock aria-hidden="true" /> SEU ESPAÇO PESSOAL
          </p>
          <h2>{challenge ? 'Digite seu código de acesso' : 'Entre no seu Astra'}</h2>
          <p className="ac-login-subtitle">
            {challenge
              ? `Confira o ${maskedPhone(confirmedPhone).toLowerCase()}.`
              : 'Acesse suas finanças, compromissos e lembretes.'}
          </p>
          {session.loading ? (
            <p role="status" className="ac-loading-copy">
              Preparando seu acesso…
            </p>
          ) : (
            <form className="ac-form" onSubmit={submit} noValidate aria-busy={busy}>
              {challenge ? (
                <>
                  <CustomerCodeField value={code} onChange={setCode} disabled={busy} />
                  <p className="ac-field-help" aria-live="off">
                    {expiresIn
                      ? `Código válido por ${countdownLabel(expiresIn)}.`
                      : 'Código expirado. Solicite um novo para continuar.'}
                  </p>
                </>
              ) : (
                <CustomerPhoneField value={phone} onChange={setPhone} disabled={busy} />
              )}
              {error ? <CustomerError error={error} /> : null}
              <button
                className="ac-button ac-button--full"
                type="submit"
                disabled={busy || (!challenge && retryIn > 0)}
              >
                {busy ? (
                  'Aguarde…'
                ) : challenge ? (
                  <>
                    <Check aria-hidden="true" />
                    Acessar meu painel
                  </>
                ) : (
                  <>
                    <MessageSquare aria-hidden="true" />
                    Receber código no WhatsApp
                  </>
                )}
              </button>
              {challenge ? (
                <>
                  <p className="ac-auth-generic">
                    {challenge.message ||
                      'Se este número tiver acesso ao Astra, você receberá um código pelo WhatsApp.'}
                  </p>
                  <div className="ac-auth-actions">
                    <button
                      className="ac-text-button"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setChallenge(null);
                        setCode('');
                        setError(null);
                      }}
                    >
                      <ArrowLeft aria-hidden="true" />
                      Alterar número
                    </button>
                    <button
                      className="ac-text-button"
                      type="button"
                      disabled={busy || retryIn > 0}
                      onClick={() => void requestCode()}
                    >
                      {retryIn ? `Reenviar em ${countdownLabel(retryIn)}` : 'Reenviar código'}
                    </button>
                  </div>
                </>
              ) : (
                <p className="ac-auth-generic">
                  {retryIn
                    ? `Tente novamente em ${countdownLabel(retryIn)}.`
                    : 'Se este número tiver acesso ao Astra, você receberá um código pelo WhatsApp.'}
                </p>
              )}
            </form>
          )}
          <details className="ac-login-help">
            <summary>Preciso de ajuda</summary>
            <p>
              Use o número autorizado no seu acesso ao Astra e confira se ele está conectado ao
              WhatsApp. Para dúvidas sobre seu acesso,{' '}
              <a
                href="https://astra-landing-production.up.railway.app/#contato"
                target="_blank"
                rel="noopener noreferrer"
              >
                fale com a equipe Astra
              </a>
              .
            </p>
          </details>
          <p className="ac-login-security">
            <Lock aria-hidden="true" />
            Seu acesso é confirmado no seu WhatsApp.
          </p>
        </main>
      </div>
    </div>
  );
}
