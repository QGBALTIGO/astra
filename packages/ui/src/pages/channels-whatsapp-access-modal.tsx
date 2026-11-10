import { useId, useRef, useState, type FormEvent } from 'react';
import { channelsApi } from '../api/endpoints/misc';
import type { ChannelUser } from '../api/types/channels';
import { Modal } from '../components/Modal';
import { ShieldCheck } from '../components/icons';
import { formatWhatsAppPhone, normalizeWhatsAppPhone } from './channels-access-helpers';

interface WhatsAppAuthorizeModalProps {
  user?: ChannelUser;
  onClose: () => void;
  onAuthorized: (user: ChannelUser) => void;
}

const inputClass =
  'w-full min-h-11 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 dark:border-dark-border dark:bg-dark-bg-primary dark:text-dark-text-primary dark:placeholder:text-dark-text-muted';

export function WhatsAppAuthorizeModal({
  user,
  onClose,
  onAuthorized,
}: WhatsAppAuthorizeModalProps) {
  const formId = useId();
  const phoneId = useId();
  const nameId = useId();
  const phoneHelpId = useId();
  const phoneErrorId = useId();
  const [phoneNumber, setPhoneNumber] = useState(
    user ? formatWhatsAppPhone(user.platformUserId) : ''
  );
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [duration, setDuration] = useState<'30' | 'unlimited'>('30');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const phoneRef = useRef<HTMLInputElement>(null);
  const normalizedPhone = normalizeWhatsAppPhone(phoneNumber);

  const handleClose = () => {
    if (!savingRef.current) onClose();
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (savingRef.current) return;
    if (!normalizedPhone) {
      setPhoneError('Informe um número válido com DDI e DDD. No Brasil, use +55 e o DDD.');
      phoneRef.current?.focus();
      return;
    }
    savingRef.current = true;
    setIsSaving(true);
    setPhoneError(null);
    setSubmitError(null);
    try {
      const { user: authorizedUser } = await channelsApi.authorizeWhatsAppUser({
        platform: 'whatsapp',
        phoneNumber: normalizedPhone,
        displayName: displayName.trim() || undefined,
        durationDays: duration === '30' ? 30 : null,
      });
      onAuthorized(authorizedUser);
      onClose();
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'Não foi possível autorizar este número. Tente novamente.'
      );
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  return (
    <Modal
      onClose={handleClose}
      ariaLabel="Autorizar número no WhatsApp"
      title="Autorizar número"
      size="lg"
      headerContent={
        <p className="mt-1 text-sm text-text-muted dark:text-dark-text-muted">
          Libere o acesso ao Astra antes mesmo da primeira conversa.
        </p>
      }
      footer={
        <>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSaving}
            className="min-h-11 rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-secondary disabled:opacity-50 dark:border-dark-border dark:text-dark-text-secondary dark:hover:bg-dark-bg-secondary"
          >
            Cancelar
          </button>
          <button
            type="submit"
            form={formId}
            disabled={isSaving}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
          >
            <ShieldCheck className="h-4 w-4" />
            {isSaving ? 'Autorizando…' : 'Autorizar número'}
          </button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={handleSubmit}
        noValidate
        aria-busy={isSaving}
        className="space-y-5"
      >
        <div className="space-y-2">
          <label
            htmlFor={phoneId}
            className="block text-sm font-medium text-text-primary dark:text-dark-text-primary"
          >
            Número do WhatsApp
          </label>
          <input
            ref={phoneRef}
            id={phoneId}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+55 (67) 99999-9999"
            required
            maxLength={64}
            disabled={isSaving}
            value={phoneNumber}
            onChange={(event) => {
              setPhoneNumber(event.target.value);
              setPhoneError(null);
            }}
            aria-invalid={Boolean(phoneError)}
            aria-describedby={phoneHelpId + (phoneError ? ' ' + phoneErrorId : '')}
            className={inputClass}
          />
          <p
            id={phoneHelpId}
            className="text-xs leading-relaxed text-text-muted dark:text-dark-text-muted"
          >
            Brasil: +55, DDD e número. Você também pode informar só o DDD e o número. Para outro
            país, comece com + e o DDI.
          </p>
          {phoneError ? (
            <p id={phoneErrorId} role="alert" className="text-xs text-error">
              {phoneError}
            </p>
          ) : normalizedPhone ? (
            <p className="text-xs font-medium text-primary">
              Número que será autorizado: {formatWhatsAppPhone(normalizedPhone)}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <label
            htmlFor={nameId}
            className="block text-sm font-medium text-text-primary dark:text-dark-text-primary"
          >
            Nome{' '}
            <span className="font-normal text-text-muted dark:text-dark-text-muted">
              (opcional)
            </span>
          </label>
          <input
            id={nameId}
            type="text"
            autoComplete="name"
            maxLength={120}
            placeholder="Como você identifica este contato"
            value={displayName}
            disabled={isSaving}
            onChange={(event) => setDisplayName(event.target.value)}
            className={inputClass}
          />
        </div>

        <fieldset disabled={isSaving} className="space-y-2">
          <legend className="mb-2 text-sm font-medium text-text-primary dark:text-dark-text-primary">
            Prazo de acesso
          </legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5 dark:border-dark-border">
              <input
                type="radio"
                name={formId + '-duration'}
                value="30"
                checked={duration === '30'}
                onChange={() => setDuration('30')}
                className="mt-0.5 accent-primary"
              />
              <span>
                <span className="block text-sm font-medium text-text-primary dark:text-dark-text-primary">
                  30 dias
                </span>
                <span className="mt-1 block text-xs text-text-muted dark:text-dark-text-muted">
                  A partir da autorização.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5 dark:border-dark-border">
              <input
                type="radio"
                name={formId + '-duration'}
                value="unlimited"
                checked={duration === 'unlimited'}
                onChange={() => setDuration('unlimited')}
                className="mt-0.5 accent-primary"
              />
              <span>
                <span className="block text-sm font-medium text-text-primary dark:text-dark-text-primary">
                  Sem vencimento
                </span>
                <span className="mt-1 block text-xs text-text-muted dark:text-dark-text-muted">
                  Até você revogar o acesso.
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        {submitError ? (
          <div
            role="alert"
            className="rounded-lg border border-error/20 bg-error/5 p-3 text-sm text-error"
          >
            {submitError}
          </div>
        ) : null}
        {isSaving ? (
          <p role="status" className="text-sm text-text-muted dark:text-dark-text-muted">
            Autorizando o número. Aguarde a confirmação.
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
