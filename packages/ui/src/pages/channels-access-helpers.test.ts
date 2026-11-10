import { describe, expect, it } from 'vitest';
import { normalizeWhatsAppPhone } from './channels-access-helpers';

describe('WhatsApp phone validation matches the access API', () => {
  it.each([
    ['(11) 99999-1234', '+5511999991234'],
    ['11 2345-6789', '+551123456789'],
    ['+55 (67) 99999-8888', '+5567999998888'],
    ['55 96 99999-1234', '+5596999991234'],
    ['+55 (68) 3456-7890', '+556834567890'],
    ['+1 (212) 555-0123', '+12125550123'],
    ['+44 20 7946 0958', '+442079460958'],
    ['+1234567890', '+1234567890'],
    ['+123456789012345', '+123456789012345'],
  ])('accepts %s as %s', (input, expected) => {
    expect(normalizeWhatsAppPhone(input)).toBe(expected);
  });

  it.each([
    '10',
    '20',
    '23',
    '25',
    '26',
    '29',
    '30',
    '36',
    '39',
    '50',
    '52',
    '56',
    '59',
    '60',
    '70',
    '72',
    '76',
    '78',
    '80',
    '90',
  ])('rejects unallocated Brazilian area code %s before showing a positive preview', (areaCode) => {
    expect(normalizeWhatsAppPhone('+55 ' + areaCode + ' 99999-1234')).toBeNull();
  });

  it.each([
    '+55 67 88888-8888',
    '+55 67 1234-5678',
    '+55 67 0234-5678',
    '+55 67 9999-123',
    '+55 67 999999-1234',
    '+55 67\n99999-1234',
    '+55 67\t99999-1234',
    '5567999991234@s.whatsapp.net',
    '+55 67 99999-1234 ramal 12',
    '0044 20 7946 0958',
    '+123456789',
    '+1234567890123456',
    '+01234567890',
    '+55 67 99999-1234' + ' '.repeat(65),
  ])('rejects malformed or unsupported phone %j', (input) => {
    expect(normalizeWhatsAppPhone(input)).toBeNull();
  });
});
