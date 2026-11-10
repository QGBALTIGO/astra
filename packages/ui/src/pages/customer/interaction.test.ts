/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCustomerInputModality } from './interaction';

describe('customer input modality', () => {
  let dispose: () => void;
  const mode = () => document.documentElement.getAttribute('data-astra-input');
  const key = (value: string, target: EventTarget = document) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));

  beforeEach(() => {
    document.documentElement.removeAttribute('data-astra-input');
    dispose = installCustomerInputModality(document);
  });
  afterEach(() => {
    dispose();
    document.body.replaceChildren();
  });

  it('starts with accessible keyboard focus rather than guessing the device type', () => {
    expect(mode()).toBe('keyboard');
  });
  it('recognizes a pointer without removing focus from its input', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(mode()).toBe('pointer');
    expect(document.activeElement).toBe(input);
  });
  it('keeps the quiet state while typing with a virtual keyboard', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new Event('touchstart', { bubbles: true }));
    key('a', input);
    key('Enter', input);
    expect(mode()).toBe('pointer');
  });
  it.each(['Tab', 'ArrowDown', 'Home', 'Escape'])(
    'restores keyboard focus after touch for %s',
    (value) => {
      document.dispatchEvent(new Event('touchstart'));
      key(value);
      expect(mode()).toBe('keyboard');
    }
  );
  it('does not prevent native keyboard navigation or pointer events', () => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  it('removes listeners and restores the prior document state when disposed', () => {
    dispose();
    expect(mode()).toBeNull();
    key('Tab');
    document.dispatchEvent(new Event('pointerdown'));
    expect(mode()).toBeNull();
  });
});
