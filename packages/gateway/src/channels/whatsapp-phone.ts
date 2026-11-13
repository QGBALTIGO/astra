/** Candidate dial strings for a Brazilian mobile; fixed lines and foreign numbers stay exact. */
export function whatsappPhoneSpellings(phone: string): string[] {
  const match = /^(55[1-9]\d)(9?)([6-9]\d{7})$/u.exec(phone);
  if (!match) return [phone];
  const [, area, ninth, subscriber] = match;
  return [phone, area + (ninth ? '' : '9') + subscriber];
}
