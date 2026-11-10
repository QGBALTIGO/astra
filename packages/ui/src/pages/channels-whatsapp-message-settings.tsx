import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { channelsApi } from '../api/endpoints/misc';
import type { WhatsAppAccessMessageSettings } from '../api/types/channels';
import { Modal } from '../components/Modal';
import { useToast } from '../components/ToastProvider';
import { MessageSquare, Settings } from '../components/icons';

const inputClass =
  'min-h-11 w-full min-w-0 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 dark:border-dark-border dark:bg-dark-bg-primary dark:text-dark-text-primary';
const secondaryButtonClass =
  'min-h-11 rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-secondary disabled:opacity-50 dark:border-dark-border dark:text-dark-text-secondary dark:hover:bg-dark-bg-secondary';

type SettingField = keyof WhatsAppAccessMessageSettings;
type FieldErrors = Partial<Record<SettingField, string>>;

function isSafeHttpsUrl(value: string): boolean {
  if (
    value.length > 2048 ||
    /[\p{Cc}\p{Cf}\\]/u.test(value) ||
    /%(?:0[\da-f]|1[\da-f]|7f)/i.test(value)
  ) {
    return false;
  }
  const trimmed = value.trim();
  if (/\s/.test(trimmed) || !/^https:\/\//i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isValidTimeZone(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length > 100 || !/^[A-Za-z_][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/.test(trimmed))
    return false;
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: trimmed }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function WhatsAppMessageSettingsSection() {
  const [isOpen, setIsOpen] = useState(false);
  const toast = useToast();

  return (
    <section
      aria-label="Mensagens automáticas"
      className="rounded-xl border border-border p-3 dark:border-dark-border sm:p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h4 className="flex items-center gap-2 text-sm font-medium text-text-primary dark:text-dark-text-primary">
            <MessageSquare className="h-4 w-4 shrink-0 text-text-muted dark:text-dark-text-muted" />
            Mensagens automáticas
          </h4>
          <p className="mt-1 text-xs leading-relaxed text-text-muted dark:text-dark-text-muted">
            Edite os links enviados nas mensagens de acesso.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className={
            secondaryButtonClass + ' inline-flex shrink-0 items-center justify-center gap-2'
          }
        >
          <Settings className="h-4 w-4" />
          Configurar mensagens
        </button>
      </div>
      {isOpen ? (
        <WhatsAppMessageSettingsModal
          onClose={() => setIsOpen(false)}
          onSaved={() => toast.success('Mensagens automáticas atualizadas')}
        />
      ) : null}
    </section>
  );
}

function WhatsAppMessageSettingsModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const [settings, setSettings] = useState<WhatsAppAccessMessageSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    channelsApi.getWhatsAppAccessMessageSettings().then(
      ({ settings: loaded }) => {
        if (!cancelled) {
          setSettings(loaded);
          setIsLoading(false);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : 'Não foi possível carregar as configurações.'
          );
          setIsLoading(false);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const handleClose = () => {
    if (!savingRef.current) onClose();
  };
  const updateField = (field: SettingField, value: string) => {
    setSettings((current) => (current ? { ...current, [field]: value } : null));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (savingRef.current || !settings || isLoading) return;
    const errors: FieldErrors = {};
    if (!isSafeHttpsUrl(settings.siteUrl))
      errors.siteUrl = 'Informe um endereço HTTPS válido, sem credenciais.';
    if (settings.renewalUrl?.trim() && !isSafeHttpsUrl(settings.renewalUrl)) {
      errors.renewalUrl = 'Informe um link HTTPS válido ou deixe este campo vazio.';
    }
    if (!isValidTimeZone(settings.timeZone))
      errors.timeZone = 'Informe um fuso válido, como America/Campo_Grande.';
    setFieldErrors(errors);
    const invalidField = (Object.keys(errors) as SettingField[])[0];
    if (invalidField) {
      formRef.current?.querySelector<HTMLInputElement>(`[name="${invalidField}"]`)?.focus();
      return;
    }
    savingRef.current = true;
    setIsSaving(true);
    setSubmitError(null);
    try {
      await channelsApi.updateWhatsAppAccessMessageSettings({
        siteUrl: settings.siteUrl.trim(),
        renewalUrl: settings.renewalUrl?.trim() || null,
        timeZone: settings.timeZone.trim(),
      });
      onSaved();
      onClose();
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : 'Não foi possível salvar. Tente novamente.'
      );
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  return (
    <Modal
      title="Mensagens automáticas"
      ariaLabel="Configurar mensagens automáticas do WhatsApp"
      size="lg"
      onClose={handleClose}
      headerContent={
        <p className="mt-1 text-sm text-text-muted dark:text-dark-text-muted">
          Links e horário usados nos avisos de acesso do Astra.
        </p>
      }
      footerClassName="flex flex-wrap justify-end gap-2 border-t border-border p-4 dark:border-dark-border"
      footer={
        <>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSaving}
            className={secondaryButtonClass}
          >
            Cancelar
          </button>
          <button
            type="submit"
            form={id}
            disabled={isLoading || !settings || isSaving}
            className="min-h-11 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
          >
            {isSaving ? 'Salvando…' : 'Salvar configurações'}
          </button>
        </>
      }
    >
      {isLoading ? (
        <p role="status" className="text-sm text-text-muted dark:text-dark-text-muted">
          Carregando configurações…
        </p>
      ) : loadError ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-error">
            {loadError}
          </p>
          <button
            type="button"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            className={secondaryButtonClass}
          >
            Tentar novamente
          </button>
        </div>
      ) : settings ? (
        <form
          ref={formRef}
          id={id}
          onSubmit={handleSubmit}
          noValidate
          aria-busy={isSaving}
          className="space-y-5"
        >
          <div className="space-y-2">
            <label
              htmlFor={id + '-site'}
              className="block text-sm font-medium text-text-primary dark:text-dark-text-primary"
            >
              Site do Astra
            </label>
            <input
              id={id + '-site'}
              name="siteUrl"
              type="url"
              inputMode="url"
              autoComplete="url"
              maxLength={2048}
              required
              disabled={isSaving}
              value={settings.siteUrl}
              onChange={(event) => updateField('siteUrl', event.target.value)}
              aria-invalid={Boolean(fieldErrors.siteUrl)}
              aria-describedby={fieldErrors.siteUrl ? id + '-site-error' : undefined}
              className={inputClass}
            />
            {fieldErrors.siteUrl ? (
              <p id={id + '-site-error'} role="alert" className="text-xs text-error">
                {fieldErrors.siteUrl}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <label
              htmlFor={id + '-renewal'}
              className="block text-sm font-medium text-text-primary dark:text-dark-text-primary"
            >
              Link de renovação da Cakto{' '}
              <span className="font-normal text-text-muted dark:text-dark-text-muted">
                (opcional)
              </span>
            </label>
            <input
              id={id + '-renewal'}
              name="renewalUrl"
              type="url"
              inputMode="url"
              autoComplete="off"
              maxLength={2048}
              disabled={isSaving}
              value={settings.renewalUrl ?? ''}
              onChange={(event) => updateField('renewalUrl', event.target.value)}
              aria-invalid={Boolean(fieldErrors.renewalUrl)}
              aria-describedby={
                id + '-renewal-help' + (fieldErrors.renewalUrl ? ' ' + id + '-renewal-error' : '')
              }
              className={inputClass}
            />
            <p
              id={id + '-renewal-help'}
              className="text-xs leading-relaxed text-text-muted dark:text-dark-text-muted"
            >
              {settings.renewalUrl?.trim()
                ? 'Use o link real de renovação da Cakto.'
                : 'Link ainda não configurado. Enquanto isso, as mensagens usam o site do Astra.'}
            </p>
            {fieldErrors.renewalUrl ? (
              <p id={id + '-renewal-error'} role="alert" className="text-xs text-error">
                {fieldErrors.renewalUrl}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <label
              htmlFor={id + '-zone'}
              className="block text-sm font-medium text-text-primary dark:text-dark-text-primary"
            >
              Fuso horário da validade
            </label>
            <input
              id={id + '-zone'}
              name="timeZone"
              type="text"
              autoComplete="off"
              list={id + '-zones'}
              maxLength={100}
              required
              disabled={isSaving}
              value={settings.timeZone}
              onChange={(event) => updateField('timeZone', event.target.value)}
              aria-invalid={Boolean(fieldErrors.timeZone)}
              aria-describedby={
                id + '-zone-help' + (fieldErrors.timeZone ? ' ' + id + '-zone-error' : '')
              }
              className={inputClass}
            />
            <datalist id={id + '-zones'}>
              <option value="America/Campo_Grande">Campo Grande</option>
              <option value="America/Sao_Paulo">Brasília</option>
              <option value="America/Manaus">Manaus</option>
              <option value="America/Rio_Branco">Rio Branco</option>
              <option value="America/Noronha">Fernando de Noronha</option>
              <option value="UTC">UTC</option>
            </datalist>
            <p
              id={id + '-zone-help'}
              className="text-xs leading-relaxed text-text-muted dark:text-dark-text-muted"
            >
              Usado para mostrar o vencimento nas mensagens. Ex.: America/Campo_Grande.
            </p>
            {fieldErrors.timeZone ? (
              <p id={id + '-zone-error'} role="alert" className="text-xs text-error">
                {fieldErrors.timeZone}
              </p>
            ) : null}
          </div>
          {submitError ? (
            <p role="alert" className="rounded-lg bg-error/5 p-3 text-sm text-error">
              {submitError}
            </p>
          ) : null}
        </form>
      ) : null}
    </Modal>
  );
}
