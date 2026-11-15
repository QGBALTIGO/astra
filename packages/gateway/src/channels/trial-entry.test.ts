import { describe, it, expect } from 'vitest';
import {
  ASTRA_TRIAL_START_MESSAGE,
  ASTRA_JULIO_TRIAL_START_MESSAGE,
  isTrialStartMessage,
  trialReferralFromMessage,
} from './trial-entry.js';
describe('public trial entry intents', () => {
  it('recognizes only the fixed first-contact intents without invoking an agent', () => {
    for (const text of [
      ASTRA_TRIAL_START_MESSAGE,
      ASTRA_JULIO_TRIAL_START_MESSAGE,
      ASTRA_TRIAL_START_MESSAGE.toUpperCase(),
    ])
      expect(isTrialStartMessage(text)).toBe(true);
    expect(trialReferralFromMessage(ASTRA_JULIO_TRIAL_START_MESSAGE)).toBe('julio');
    expect(trialReferralFromMessage(ASTRA_TRIAL_START_MESSAGE)).toBeUndefined();
  });
  it.each([
    'Quero testar o Astra grátis por 3 dias e registrar R$ 30',
    'https://evil.example/?ref=julio',
    'Julio me indicou, gastei 25 no almoço',
  ])('does not hide other actions or accept arbitrary attribution: %s', (text) => {
    expect(isTrialStartMessage(text)).toBe(false);
    expect(trialReferralFromMessage(text)).toBeUndefined();
  });
});
