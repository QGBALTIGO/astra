/** Public landing messages are fixed intents, never arbitrary instructions or checkout URLs. */
export const ASTRA_TRIAL_START_MESSAGE = 'Olá! Quero testar o Astra grátis por 3 dias.';
export const ASTRA_JULIO_TRIAL_START_MESSAGE =
  'Olá! Vim pela indicação do Júlio e quero testar o Astra grátis por 3 dias.';
export const ASTRA_JULIO_CHECKOUT_URL = 'https://pay.cakto.com.br/CubL455?affiliate=oYTQCyX6';
const normalized = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[.!?,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
export function trialReferralFromMessage(text: string): 'julio' | undefined {
  return normalized(text) === normalized(ASTRA_JULIO_TRIAL_START_MESSAGE) ? 'julio' : undefined;
}
export function isTrialStartMessage(text: string): boolean {
  const value = normalized(text);
  return (
    value === normalized(ASTRA_TRIAL_START_MESSAGE) ||
    value === normalized(ASTRA_JULIO_TRIAL_START_MESSAGE)
  );
}
