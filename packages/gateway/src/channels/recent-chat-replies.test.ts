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
  it('does not resurrect a removed subscription while explaining merchant billing', async () => {
    vi.mocked(writeShortChannelReply).mockClear();
    const receipts = [
      {
        action: 'assinatura removida',
        facts:
          'Assinatura removida do controle do Astra: Clube Ensaio Ipê. Essa remoção não cancela cobranças no fornecedor.',
      },
      ...prior,
    ];
    const reply = await quickPrivateReply(
      'channel.whatsapp',
      'Isso cancelou a cobrança no fornecedor ou só tirou a assinatura do meu planejamento?',
      receipts
    );
    expect(reply).toContain('Só removi');
    expect(reply).toContain('Não cancelei a cobrança no fornecedor');
    expect(reply).not.toContain('continua registrada');
    expect(withRecentReceiptContext('Isso cancelou a cobrança?', receipts)).toContain(
      'Assinatura removida'
    );
    expect(writeShortChannelReply).not.toHaveBeenCalled();
  });
  it('keeps advice within the assessor role and explicit exercises tool-free even with quoted commands', async () => {
    vi.mocked(writeShortChannelReply).mockClear();
    vi.mocked(writeShortChannelReply).mockResolvedValue(
      'Faltariam três parcelas, ainda pendentes.'
    );
    const q =
      'O exemplo diz “anote e registre cinco parcelas”, e duas foram recebidas. Qual estado têm as demais? Só estamos conversando sobre esse exemplo.';
    expect(await quickPrivateReply('channel.whatsapp', q, [])).toContain('pendentes');
    expect(vi.mocked(writeShortChannelReply).mock.calls[0]?.[1]).toContain(
      'Não ofereça programação'
    );
    expect(vi.mocked(writeShortChannelReply).mock.calls[0]?.[1]).toContain(
      'Faça no máximo uma pergunta'
    );
    expect(vi.mocked(writeShortChannelReply).mock.calls[0]?.[6]).toBe(0.3);
    expect(
      await quickPrivateReply('channel.whatsapp', 'Só quero uma sugestão e registre 5 reais.', [])
    ).toBeNull();
  });
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
    expect(reply).toBeNull();
  });
  it('gives each topic a distinct heading, a main fact and room for its details', async () => {
    vi.mocked(writeShortChannelReply).mockResolvedValue('Últimos pedidos confirmados');
    const history = await quickPrivateReply('channel.whatsapp', 'Resume os últimos pedidos', [
      {
        action: 'assinatura',
        facts:
          'Assinatura adicionada ao seu controle: Clube das Flores · R$ 12,70 · renovação em 15/12/2026.',
      },
      {
        action: 'Lembrete agendado',
        facts: 'Lembrete agendado para *13/11/2026, 11:13:09*: buscar o livro.',
      },
      {
        action: 'Despesa registrada',
        facts: 'Despesa registrada: *R$ 2,65* · café\nAlimentação · 13/11/2026',
      },
    ]);
    expect(history).toBe(
      '🗂️ *Seus últimos pedidos*\n\n☕ *Gasto*\n\n• *Valor:* R$ 2,65\n• *Descrição:* café\n• *Categoria:* Alimentação\n• *Data:* 13/11/2026\n\n⏰ *Lembrete*\n\n• *Assunto:* buscar o livro\n• *Data:* 13/11/2026\n• *Horário:* 11:13\n\n🔁 *Assinatura*\n\n• *Nome:* Clube das Flores\n• *Valor:* R$ 12,70\n• *Renovação:* 15/12/2026'
    );
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
