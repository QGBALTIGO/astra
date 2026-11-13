import { describe, expect, it, vi } from 'vitest';
import {
  quickPrivateReply,
  asksAboutRecentReceipts,
  withRecentReceiptContext,
} from './recent-chat-replies.js';
import { writeShortChannelReply } from './short-channel-reply.js';
vi.mock('./short-channel-reply.js', () => ({ writeShortChannelReply: vi.fn() }));
const prior = [
  { action: 'assinatura', facts: 'Clube Jasmim · R$ 14,90' },
  { action: 'Lembrete agendado', facts: 'buscar o livro às 16:00' },
  { action: 'Despesa registrada', facts: 'R$ 5,00 · café' },
];
describe('recalling recent private receipts', () => {
  it('discards a plausible but invented dashboard domain even without https', async () => {
    vi.mocked(writeShortChannelReply).mockResolvedValue(
      'Entro em astra.app, clico em Agenda e toco em Criar item.'
    );
    const reply = await quickPrivateReply(
      'channel.whatsapp',
      'Como posso planejar a minha semana no painel do Astra?',
      []
    );
    expect(reply).toContain('https://app.astraacessor.pro/cliente/entrar');
    expect(reply).not.toContain('astra.app');
  });
  it('uses AI for a short standalone planning tip and keeps mixed requests on the tool path', async () => {
    vi.mocked(writeShortChannelReply).mockResolvedValue(
      'Enquanto passa o café, escolha uma prioridade.'
    );
    expect(
      await quickPrivateReply(
        'channel.whatsapp',
        'Tenho dez minutos para planejar o dia. Me dá uma ideia bem curta, sem criar nada agora?',
        []
      )
    ).toContain('café');
    expect(
      await quickPrivateReply(
        'channel.whatsapp',
        'Para planejar me dá uma ideia curta e registre um gasto.',
        []
      )
    ).toBeNull();
  });
  it('answers the requested earlier topic even after two intervening subjects', async () => {
    vi.mocked(writeShortChannelReply).mockResolvedValue('Foi o café!');
    const reply = await quickPrivateReply('channel.whatsapp', 'Qual foi meu último gasto?', prior);
    expect(reply).toContain('R$ 5,00');
    expect(reply).not.toContain('Jasmim');
  });
  it('keeps the receipts in chronology when asked for several', async () => {
    vi.mocked(writeShortChannelReply).mockResolvedValue('Aqui vai!');
    const reply = await quickPrivateReply('channel.whatsapp', 'Resume os últimos pedidos', prior);
    expect(reply).toMatch(/café[\s\S]+livro[\s\S]+Jasmim/u);
  });
  it('preserves account reads and compound operations in the normal tool path', () => {
    for (const q of [
      'Quanto gastei hoje?',
      'Qual foi meu último gasto? E apaga ele.',
      'Atualize a assinatura',
      'Cancele esse lembrete',
    ])
      expect(asksAboutRecentReceipts(q)).toBe(false);
  });
  it('does not feed sensitive receipts back to a model', () => {
    expect(withRecentReceiptContext('e esse?', [{ facts: 'consulta médica de retorno' }])).toBe(
      'e esse?'
    );
  });
});
