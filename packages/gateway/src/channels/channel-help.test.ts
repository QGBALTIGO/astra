import { describe, expect, it } from 'vitest';
import { channelHelpReply } from './channel-help.js';
import { whatsappNormalizer } from './normalizers/whatsapp.js';

describe('concise channel help', () => {
  it.each(['Como eu te uso', 'como posso te usar?', 'Astra, o que você faz?', '/help'])(
    'answers the usage question in the current channel: %s',
    (request) => {
      const answer = channelHelpReply('whatsapp', request, { connectedAppsEnabled: true });
      expect(answer).toContain('aqui no WhatsApp');
      expect(answer).toContain('*Finanças:*');
      expect(answer).toContain('com o Gmail conectado');
      expect(answer).not.toMatch(/Telegram|\*\*|<[^>]*>|API|provedor/);
      expect(answer!.length).toBeLessThan(700);
      expect(whatsappNormalizer.normalizeOutgoing(answer!)).toEqual([answer]);
    }
  );
  it('does not advertise disabled connections or the wrong channel', () => {
    const answer = channelHelpReply('telegram', 'Como usar o Astra?');
    expect(answer).toContain('aqui no Telegram');
    expect(answer).not.toMatch(/WhatsApp|Gmail|E-mails/);
  });
  it.each([
    'Crie uma tarefa chamada ajuda',
    'Como eu te uso para apagar uma entrada?',
    'Me ajuda com as contas',
    'Como usar o Gmail?',
  ])('leaves a specific request to its own handler: %s', (request) =>
    expect(channelHelpReply('whatsapp', request)).toBeNull()
  );
  it('leaves web conversations unchanged', () => {
    expect(channelHelpReply('web', 'Como eu te uso?')).toBeNull();
  });
});
