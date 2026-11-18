/** A short channel guide with examples; never claims that an action was executed. */
export function channelHelpReply(
  platform: string,
  text: string,
  options: { connectedAppsEnabled?: boolean } = {}
): string | null {
  if (platform !== 'whatsapp' && platform !== 'telegram') return null;
  const input = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/^astra[,!\s]+/, '')
    .replace(/[?!.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    !/^(?:\/?(?:ajuda|help)|como (?:eu )?(?:te uso|uso (?:voce|o astra))|como (?:posso|eu posso) te usar|como (?:te usar|usar (?:voce|o astra))|o que (?:voce|vc) (?:faz|pode fazer)(?: por mim)?|quais (?:sao )?(?:suas funcoes|as suas funcoes))$/.test(
      input
    )
  )
    return null;
  const channel = platform === 'whatsapp' ? 'WhatsApp' : 'Telegram';
  return [
    `Pode falar comigo aqui no ${channel}, do seu jeito. 😊`,
    '• *Finanças:* “Gastei R$ 30 no almoço.”\n' +
      '• *Pendências:* “Quais valores tenho a receber?”\n' +
      '• *Lembretes:* “Me lembre amanhã às 9h de ligar para Ana.”\n' +
      '• *Tarefas e agenda:* “Crie uma tarefa para revisar o contrato.”' +
      (options.connectedAppsEnabled
        ? '\n• *E-mails:* com o Gmail conectado, “Mostre meus últimos e-mails.”'
        : ''),
    'Também posso corrigir registros e organizar sua rotina. Por onde quer começar?',
  ].join('\n\n');
}
