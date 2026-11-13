import { describe, expect, it } from 'vitest';
import { phoneTimeZone } from './phone-timezone.js';
describe('initial customer timezone', () => {
  it.each([
    ['5538999990000', 'America/Sao_Paulo'],
    ['553899990000', 'America/Sao_Paulo'],
    ['5565999990000', 'America/Cuiaba'],
    ['5566999990000', 'America/Cuiaba'],
    ['5567999990000', 'America/Campo_Grande'],
    ['5568999990000', 'America/Rio_Branco'],
    ['5592999990000', 'America/Manaus'],
    ['5511999990000', 'America/Sao_Paulo'],
    ['+14155550123', 'UTC'],
  ])('%s starts in %s', (phone, zone) => expect(phoneTimeZone(phone)).toBe(zone));
});
