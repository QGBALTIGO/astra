import { useId, useState } from 'react';
import { formatWhatsAppPhone, normalizeWhatsAppPhone } from '../channels-access-helpers';

export { normalizeWhatsAppPhone };
export function CustomerPhoneField({
  value,
  onChange,
  disabled,
  label = 'Número do WhatsApp',
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  const [country, setCountry] = useState('BR');
  return (
    <div className="ac-phone-field">
      <label htmlFor={id + '-country'}>
        País
        <select
          id={id + '-country'}
          value={country}
          disabled={disabled}
          onChange={(event) => {
            setCountry(event.target.value);
            onChange('');
          }}
        >
          <option value="BR">Brasil (+55)</option>
          <option value="other">Outro país</option>
        </select>
      </label>
      <label htmlFor={id}>
        {label}
        <input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={value}
          maxLength={64}
          required
          disabled={disabled}
          placeholder={country === 'BR' ? '(67) 99999-8888' : '+DDI e número'}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => {
            const normalized = normalizeWhatsAppPhone(value);
            if (normalized) onChange(formatWhatsAppPhone(normalized));
          }}
          aria-describedby={id + '-help'}
        />
      </label>
      <p id={id + '-help'} className="ac-field-help">
        {country === 'BR'
          ? 'Informe o DDD e o número autorizado. Para celular brasileiro, pode digitar com ou sem o nono dígito.'
          : 'Comece com + e o código do país.'}
      </p>
    </div>
  );
}
export function CustomerCodeField({
  value,
  onChange,
  disabled,
  label = 'Código de 6 dígitos',
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id}>
        {label}
        <input
          className="ac-code-input"
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
          onPaste={(event) => {
            const code = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
            if (code) {
              event.preventDefault();
              onChange(code);
            }
          }}
          required
          aria-describedby={id + '-help'}
        />
      </label>
      <span id={id + '-help'} className="ac-field-help">
        Você pode colar o código inteiro aqui.
      </span>
    </div>
  );
}
export function maskedPhone(phone: string) {
  return 'WhatsApp terminado em ' + phone.replace(/\D/g, '').slice(-4);
}
export function countdownLabel(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
