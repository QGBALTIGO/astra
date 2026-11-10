import { useRef, useState, type FormEvent } from 'react';
import { customerApi, CustomerApiError } from './api';
import {
  CustomerCodeField,
  CustomerPhoneField,
  countdownLabel,
  maskedPhone,
  normalizeWhatsAppPhone,
} from './AccessForms';
import { CustomerDialog, CustomerError } from './components';
import { useCountdown } from './hooks';
import type { Customer, CustomerChallenge } from './types';

export function CustomerPhoneChange({
  canWrite,
  onClose,
  onChanged,
}: {
  canWrite: boolean;
  onClose: () => void;
  onChanged: (customer: Customer) => void;
}) {
  const [step, setStep] = useState<'phone' | 'old' | 'new'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<CustomerChallenge | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [expiresAt, setExpiresAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const lock = useRef(false);
  const retryIn = useCountdown(retryAt);
  const expiresIn = useCountdown(expiresAt);
  const applyChallenge = (next: CustomerChallenge) => {
    setChallenge(next);
    setRetryAt(Date.now() + next.retryAfter * 1000);
    setExpiresAt(Date.now() + next.expiresIn * 1000);
    setCode('');
    setRestartRequired(false);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current || restartRequired || !canWrite) return;
    const normalized = normalizeWhatsAppPhone(phone);
    if (step === 'phone' && (!normalized || retryIn > 0)) {
      setError(
        !normalized
          ? 'Informe um número válido com DDI e DDD.'
          : `Aguarde ${countdownLabel(retryIn)} para solicitar novamente.`
      );
      return;
    }
    if (step !== 'phone' && (!challenge || !/^\d{6}$/.test(code) || !expiresIn)) {
      setError(
        !expiresIn ? 'O código expirou. Reinicie a confirmação.' : 'Informe os 6 dígitos do código.'
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (step === 'phone') {
        applyChallenge(await customerApi.requestPhoneChange(normalized!));
        setStep('old');
      } else if (step === 'old') {
        applyChallenge(await customerApi.confirmOldPhone(challenge!.challengeId, code));
        setStep('new');
      } else {
        const result = await customerApi.confirmNewPhone(challenge!.challengeId, code);
        onChanged(result.customer);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível confirmar a troca.');
      if (failure instanceof CustomerApiError && failure.retryAfter)
        setRetryAt(Date.now() + failure.retryAfter * 1000);
      // The current-number code can already be consumed if delivery to the new
      // number fails. A fresh challenge is required after an ambiguous failure.
      if (step === 'old' && (!(failure instanceof CustomerApiError) || failure.status !== 401)) {
        setRestartRequired(true);
        setCode('');
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <CustomerDialog title="Alterar número do WhatsApp" onClose={onClose} busy={busy}>
      <form className="ac-form" onSubmit={submit} noValidate aria-busy={busy}>
        <p className="ac-eyebrow">
          ETAPA {step === 'phone' ? '1' : step === 'old' ? '2' : '3'} DE 3
        </p>
        {step === 'phone' ? (
          <>
            <p className="ac-body-copy">
              Primeiro confirmamos seu número atual. Depois, enviamos um código para o novo número.
              Sua conta e seu histórico serão preservados.
            </p>
            <CustomerPhoneField
              value={phone}
              onChange={setPhone}
              disabled={busy}
              label="Novo número do WhatsApp"
            />
          </>
        ) : (
          <>
            <p className="ac-body-copy">
              {step === 'old'
                ? 'Confirme o código enviado ao seu WhatsApp atual.'
                : `Agora confirme o código enviado ao ${maskedPhone(phone).toLowerCase()}.`}
            </p>
            <CustomerCodeField value={code} onChange={setCode} disabled={busy || restartRequired} />
            <p className="ac-field-help">
              {expiresIn
                ? `Código válido por ${countdownLabel(expiresIn)}.`
                : 'Este código expirou.'}
            </p>
          </>
        )}
        {error ? <CustomerError error={error} /> : null}
        {restartRequired ? (
          <p className="ac-field-help">
            Reinicie a confirmação para receber um novo código no número atual.
          </p>
        ) : null}
        <button
          type="submit"
          className="ac-button ac-button--full"
          disabled={busy || !canWrite || restartRequired || (step === 'phone' && retryIn > 0)}
        >
          {busy
            ? 'Confirmando…'
            : step === 'phone'
              ? 'Confirmar número atual'
              : step === 'old'
                ? 'Confirmar e enviar ao novo número'
                : 'Concluir troca de número'}
        </button>
        {step !== 'phone' ? (
          <button
            type="button"
            className="ac-text-button"
            disabled={busy || retryIn > 0}
            onClick={() => {
              setStep('phone');
              setRestartRequired(false);
              setCode('');
              setChallenge(null);
              setError(null);
            }}
          >
            {retryIn ? `Reiniciar em ${countdownLabel(retryIn)}` : 'Reiniciar confirmação'}
          </button>
        ) : null}
        <p className="ac-field-help">
          Ao concluir, as outras sessões serão encerradas. Você continuará conectado neste aparelho.
        </p>
      </form>
    </CustomerDialog>
  );
}
