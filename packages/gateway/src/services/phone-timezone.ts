/** Initial estimate from the Brazilian numbering area. A customer's explicit choice wins. */
export function phoneTimeZone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!/^55\d{10,11}$/.test(digits)) return 'UTC';
  const ddd = digits.slice(2, 4);
  const zones: Record<string, string> = {
    '65': 'America/Cuiaba',
    '66': 'America/Cuiaba',
    '67': 'America/Campo_Grande',
    '68': 'America/Rio_Branco',
    '69': 'America/Porto_Velho',
    '92': 'America/Manaus',
    '97': 'America/Manaus',
    '95': 'America/Boa_Vista',
    '91': 'America/Belem',
    '93': 'America/Belem',
    '94': 'America/Belem',
    '96': 'America/Belem',
    '63': 'America/Araguaina',
    '71': 'America/Bahia',
    '73': 'America/Bahia',
    '74': 'America/Bahia',
    '75': 'America/Bahia',
    '77': 'America/Bahia',
    '79': 'America/Maceio',
    '82': 'America/Maceio',
    '81': 'America/Recife',
    '87': 'America/Recife',
    '83': 'America/Fortaleza',
    '84': 'America/Fortaleza',
    '85': 'America/Fortaleza',
    '88': 'America/Fortaleza',
    '86': 'America/Fortaleza',
    '89': 'America/Fortaleza',
    '98': 'America/Fortaleza',
    '99': 'America/Fortaleza',
  };
  return zones[ddd] ?? 'America/Sao_Paulo';
}
