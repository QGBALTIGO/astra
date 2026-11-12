import type { ChannelPlatform } from '@ownpilot/core/channels';

const advice =
  'Evite enviar sua senha aqui. As mensagens podem ficar registradas no histórico do Astra. Guarde a senha em um gerenciador de senhas. Para criar um lembrete, basta informar o dia e um título como “Trocar a senha do banco”.';

// Match requests to entrust a password to this chat. A reminder to rotate a
// password or a question about the user's own password manager remains actionable.
export function channelPasswordAdvice(platform: ChannelPlatform, text: string): string | null {
  if ((platform !== 'whatsapp' && platform !== 'telegram') || text.length > 1000) return null;
  const input = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const verb =
    /\b(?:guardar?|guarde|salvar?|salve|armazenar?|armazene|memorizar?|memorize|anotar?|anote|enviar?|envie|mandar?|mande|passar?|passe|compartilhar?|compartilhe)\s+(?:(?:a|as|minha|minhas|uma|essa|esta|nossa|sua)\s+){0,2}senhas?\b/u;
  if (!verb.test(input)) return null;
  if (
    /^(?:astra[,! ]+\s*)?(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)|pode\s+me\s+lembrar|(?:crie|agende|marque|adicione)\s+(?:(?:um|uma|o|a)\s+)?(?:lembrete|tarefa))\b/u.test(
      input
    )
  )
    return null;
  const inChat =
    /\b(?:aqui|neste chat|nessa conversa|nesta conversa|no whatsapp|no telegram|com voce|para voce|pra voce|voce (?:guardar|salvar|armazenar|memorizar)|(?:te|lhe) (?:enviar|mandar|passar))\b/u;
  const direct =
    /^(?:astra[,! ]+\s*)?(?:(?:voce\s+)?(?:pode|poderia|consegue)\s+)?(?:guarde|guardar|salve|salvar|memorize|memorizar|armazene|armazenar)\s+(?:(?:a|minha|essa|esta)\s+){0,2}senha(?:\s+do\s+banco)?(?:\s+para\s+mim)?[.!?]*$/u;
  return inChat.test(input) || direct.test(input) ? advice : null;
}
