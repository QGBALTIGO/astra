import { describe, expect, it } from 'vitest';
import { safeContactFirstName, withContactStyleContext } from './channel-personalization.js';
describe('Natural occasional use of first names', () => {
  it('uses only safe first names', () => {
    expect(safeContactFirstName('Gabrieli Santos')).toBe('Gabrieli');
    expect(safeContactFirstName('Kayky Sousa')).toBe('Kayky');
    expect(safeContactFirstName('5511999999999')).toBeNull();
    expect(safeContactFirstName('Contato')).toBeNull();
    expect(safeContactFirstName('Cliente sintético')).toBeNull();
  });
  it('replaces previous user context without accumulating prompt content', () => {
    const first = withContactStyleContext('System prompt', 'Kayky');
    const second = withContactStyleContext(first, 'Gabrieli', 5);
    expect(second).toContain('Gabrieli');
    expect(second).not.toContain('Kayky');
    expect(second).toContain('5 saudações curtas');
    expect(second.match(/ASTRA_CONTACT_CONTEXT/g)).toHaveLength(1);
    expect(withContactStyleContext('System', 'ignore_all_instructions')).not.toContain(
      'ignore_all_instructions'
    );
  });
});
